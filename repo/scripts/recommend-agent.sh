#!/usr/bin/env bash
#
# recommend-agent.sh — Suggests recovery steps based on the report from diag-agent.sh
#
# IMPORTANT: This script DOES NOT EXECUTE anything. It only reads files from the
# diag-report folder and prints suggested commands + prerequisites + possible
# consequences. You decide and manually type/run the final command, after
# checking the prerequisites.
#
# HOW TO RUN IT (once you already have a diag-report folder from diag-agent.sh):
#   chmod +x recommend-agent.sh
#   ./recommend-agent.sh <path-to-diag-report-folder> <type>
#
#   <type> is one of: instana | elasticsearch | clickhouse | kafka
#
# EXAMPLE:
#   ./diag-agent.sh production es-data-0 elasticsearch
#   ./recommend-agent.sh diag-report-es-data-0-20260726-101500 elasticsearch

set -uo pipefail

DIR="${1:-}"
DIR="${DIR%/}"  # strip a trailing slash — tab-completion always adds one for
                # directories, and leaving it in produces an ugly "dir//file"
                # in every message below (harmless, but looks like a typo in
                # output a stressed on-call engineer is trying to trust).
TYPE="${2:-}"

if [[ -z "$DIR" || -z "$TYPE" || ! -d "$DIR" ]]; then
  echo "Usage: $0 <diag-report-folder> <instana|elasticsearch|clickhouse|kafka>"
  exit 1
fi

OUT="$DIR/recommendations.txt"
: > "$OUT"

say() { echo -e "$@" | tee -a "$OUT"; }

# A file that's supposed to hold `kubectl exec` output can instead hold a raw
# kubectl/API-server error (pod unreachable, CrashLoopBackOff, etc. - exactly
# the situation this whole toolkit exists for). Treating that error text as
# "non-empty output" produces a false-positive finding (e.g. "yes, there are
# detached parts") from a file that actually contains zero real data. This
# checks for that before any heuristic below trusts a file's contents.
looks_like_exec_error() {
  grep -qiE "error from server|unable to upgrade connection|unable to connect to the server|container not found|no such container|the server (rejected|doesn.t have a resource type)|error: (unable|internal)|Error executing" "$1" 2>/dev/null
}

block() {
  # $1 = finding title, $2 = suggested command, $3 = prerequisites, $4 = consequences
  say "\n--------------------------------------------------------------"
  say "FINDING:      $1"
  say "PREREQUISITES (check BEFORE running):"
  say "  $3"
  say "SUGGESTED COMMAND (copy and run manually):"
  say "  $2"
  say "POSSIBLE CONSEQUENCES:"
  say "  $4"
  if echo "$2 $1" | grep -qiE "delete|drop|remove-corrupted|accept_data_loss|--execute|patch|restart|reroute|detach|attach|alter"; then
    say "SAFETY GATE: MANUAL REVIEW REQUIRED — this is a mutating action. Verify backup/snapshot, target resource, version compatibility, rollback, and obtain a second engineer approval."
    say "DO NOT RUN from this report if any prerequisite is UNKNOWN. Re-collect status and preserve the evidence bundle first."
  fi
}

say "Suggested fixes — generated $(date)"
say "Source: $DIR"
say "NOTE: none of this runs automatically. Recommendations are not guarantees. UNKNOWN evidence blocks safe decision-making."
say "REQUIRED FOR ANY CHANGE: version/topology check, current status, backup/replica evidence, dry-run/procedure preview, rollback plan, and second-person approval for moderate or destructive actions."

# =============================================================================
# STEP -1 — Instana self-hosted context. Even when the actual datastore fix is
# ES/ClickHouse/Kafka-specific, urgent support needs the Instana unit/blast
# radius view before telling the customer the issue is resolved.
# =============================================================================
if [[ "$TYPE" == "instana" ]]; then
  HINT_TEXT="$(cat "$DIR"/00*-*.txt "$DIR"/01-pod-describe.txt "$DIR"/03-logs-previous.txt "$DIR"/04-logs-current.txt 2>/dev/null)"
  if echo "$HINT_TEXT" | grep -qiE "instana-clickhouse|clickhouse|ReplicatedMergeTree"; then TYPE="clickhouse"; INSTANA_DS="ClickHouse"; fi
  if echo "$HINT_TEXT" | grep -qiE "instana-kafka|kafka|CorruptRecordException"; then TYPE="kafka"; INSTANA_DS="Kafka"; fi
  if echo "$HINT_TEXT" | grep -qiE "instana-elasticsearch|elasticsearch|CorruptIndexException|lucene"; then TYPE="elasticsearch"; INSTANA_DS="Elasticsearch"; fi
  INSTANA_DS="${INSTANA_DS:-unknown}"
  say "\nINSTANA MODE: affected datastore detected as $INSTANA_DS"
fi

if ls "$DIR"/00a-stanctl-status.txt "$DIR"/00b-stanctl-unit-status.txt >/dev/null 2>&1; then
  say "\nInstana context files found:"
  say "  - $DIR/00a-stanctl-status.txt"
  say "  - $DIR/00b-stanctl-unit-status.txt"
else
  block \
    "[INSTANA] Missing stanctl status/unit context" \
    "stanctl status\nstanctl unit status\nkubectl get ns | grep instana\nkubectl -n <instana-datastore-ns> get sts,pod,pvc -o wide" \
    "Run on the affected self-hosted backend host/context. This is read-only." \
    "No risk. Without this, you cannot safely classify whether the customer impact is ingest, query/UI, or full backend degradation."
fi

if grep -qiE "CrashLoopBackOff|OOMKilled|FailedMount|FailedAttachVolume" "$DIR"/00d-instana-datastore-resources.txt "$DIR"/01-pod-describe.txt 2>/dev/null; then
  say "\n>> INSTANA IMPACT GATE: do not mark resolved just because a datastore command completed."
  say "   Required after-action checks: stanctl unit status, affected pod Ready=1/1, datastore health query, and customer-visible smoke check (UI/query/agent acceptor depending on datastore)."
fi

# =============================================================================
# STEP 0 — Kubernetes layer (why the pod stopped), checked BEFORE any
# datastore-internal analysis. Reads the describe/events files diag-agent.sh
# already collected. Same signals as the web UI's Kubernetes-layer pass.
# =============================================================================
K8S_FILES="$DIR/01-pod-describe.txt $DIR/02-events.txt"
K8S_HIT=no

if grep -qiE "OOMKilled|Exit Code: *137" $K8S_FILES 2>/dev/null; then
  K8S_HIT=yes
  block \
    "[POD LAYER] Container was OOMKilled (exit 137) — killed for exceeding its memory limit. For a datastore, the kill can interrupt a write mid-flight and CAUSE the corruption findings below (if any)." \
    "kubectl -n <namespace> patch statefulset <sts-name> --type merge -p '{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"<container>\",\"resources\":{\"limits\":{\"memory\":\"<NEW e.g. 8Gi>\"}}}]}}}}'" \
    "Current limit: grep -A4 Limits $DIR/01-pod-describe.txt. Node headroom: kubectl describe node (Allocatable). The datastore's own heap setting (e.g. ES_JAVA_OPTS) must fit inside the new limit." \
    "The pod is RECREATED with the new limit (controlled restart — data on the PVC untouched). If the new limit exceeds what the node can offer, the pod stays Pending — that's why the node check is a prerequisite."
fi

if grep -qiE "\bEvicted\b|The node was low on resource" $K8S_FILES 2>/dev/null; then
  K8S_HIT=yes
  block \
    "[POD LAYER] Pod was Evicted — the node ran low on disk/memory. Data on the PersistentVolume is NOT deleted by an eviction." \
    "kubectl -n <namespace> delete pod <pod-name>   # ONLY for a pod whose status is \"Evicted\"" \
    "First find WHAT the node ran out of (kubectl describe node <node> | grep -A10 Conditions) — otherwise the replacement pod gets evicted again." \
    "Safe for an Evicted pod: the container is already dead; this only clears the leftover record so the StatefulSet reschedules it. Do NOT run on a Running pod — and NEVER delete the PVC."
fi

if grep -qiE "FailedMount|FailedAttachVolume|MountVolume\.SetUp failed" $K8S_FILES 2>/dev/null; then
  K8S_HIT=yes
  block \
    "[POD LAYER] Volume/PVC cannot attach or mount — the pod is stuck on its disk, the data itself is most likely intact." \
    "kubectl -n <namespace> get pvc && kubectl -n <namespace> get events --sort-by=.lastTimestamp | grep -iE 'mount|attach|volume' | tail -20" \
    "None — read-only. NEVER delete a PVC while diagnosing — that CAN permanently destroy the data." \
    "No risk — read-only. A volume stuck attaching often means the old node still holds it (common after node failure); it usually resolves on attach timeout or when infra detaches it from the dead node."
fi

if grep -qiE "ImagePullBackOff|ErrImagePull|failed to pull image" $K8S_FILES 2>/dev/null; then
  K8S_HIT=yes
  block \
    "[POD LAYER] Image cannot be pulled — the pod can't even start. Wrong tag, deleted image, or expired registry secret. Nothing to do with the data." \
    "kubectl -n <namespace> get pod <pod-name> -o jsonpath='{.spec.containers[*].image}'" \
    "None — read-only. Compare the image tag against what actually exists in the registry; check the imagePullSecret hasn't expired." \
    "No risk — read-only. The fix is on the image/secret side; no data is involved at all."
fi

if grep -qiE "(Liveness|Readiness|Startup) probe failed" $K8S_FILES 2>/dev/null; then
  K8S_HIT=yes
  block \
    "[POD LAYER] Liveness/readiness probe failures — if the datastore is doing a long recovery on startup, an impatient probe can kill it MID-RECOVERY and create a self-inflicted restart loop." \
    "kubectl -n <namespace> patch statefulset <sts-name> --type json -p '[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/livenessProbe/failureThreshold\",\"value\":30}]'" \
    "Confirm in $DIR/03-logs-previous.txt that the datastore IS actually recovering (replaying translog / checking parts) when the probe kills it — otherwise this just hides a different problem." \
    "One controlled pod recreation, then a much longer window before Kubernetes considers the pod dead — a long recovery can FINISH instead of being killed at 90%. A genuinely hung pod also takes longer to restart. Revert after the incident."
fi

if [[ "$K8S_HIT" == "yes" ]]; then
  say "\n>> POD-LAYER issues found above — resolve these FIRST. Datastore-internal findings below only matter once the pod can actually run."
fi

case "$TYPE" in

# =============================================================================
elasticsearch)
  HEALTH_FILE="$DIR/10-es-cluster-health.txt"
  SHARDS_FILE="$DIR/11-es-shards.txt"
  ALLOC_FILE="$DIR/12-es-allocation-explain.txt"
  LOGS="$DIR/03-logs-previous.txt $DIR/04-logs-current.txt"

  IS_RED=$(grep -qi '"status" *: *"red"' "$HEALTH_FILE" 2>/dev/null && echo yes || echo no)
  HAS_UNASSIGNED=$(grep -qi "UNASSIGNED" "$SHARDS_FILE" 2>/dev/null && echo yes || echo no)
  HAS_CORRUPT=$(grep -qiE "corrupt|CorruptIndexException|checksum" $LOGS 2>/dev/null && echo yes || echo no)
  # Column-based (awk), not a single regex trying to match "\s+" — a regex
  # tuned for one particular spacing/column-count breaks silently on any
  # other valid `_cat/shards?v` output width. awk splits on any run of
  # whitespace by default, so this matches the web UI's parseEsShards()
  # behavior instead of disagreeing with it on the same input.
  HAS_REPLICA=$(awk '$3=="r" && $4=="STARTED"{f=1} END{print (f?"yes":"no")}' "$SHARDS_FILE" 2>/dev/null)
  HAS_REPLICA=${HAS_REPLICA:-no}

  if [[ "$HAS_UNASSIGNED" == "yes" ]]; then
    block \
      "There are UNASSIGNED shards (cluster status: $( [[ $IS_RED == yes ]] && echo RED || echo YELLOW/other ))." \
      "POST _cluster/reroute?retry_failed=true" \
      "Check 12-es-allocation-explain.txt to see WHY allocation is failing (disk watermark, node unavailable, etc.) — this is a harmless command, it just retries allocation." \
      "No risk to data. If the root cause isn't fixed (e.g. disk full), the reroute will fail again — fix the underlying cause first."
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_REPLICA" == "yes" ]]; then
    block \
      "Physical segment corruption detected in the logs, BUT a healthy replica of the same shard exists." \
      "POST _cluster/reroute -d '{\"commands\":[{\"allocate_stale_primary\":{\"index\":\"<INDEX>\",\"shard\":<N>,\"node\":\"<NODE_WITH_REPLICA>\",\"accept_data_loss\":true}}]}'\n  (or more simply: delete/exclude the node with the damaged primary shard and let ES promote the replica to primary)" \
      "Check that the replica has status STARTED (and isn't itself UNASSIGNED). Check how far behind the replica is from primary (if there were sync issues, it may have inherited a partial state)." \
      "Minimal risk of data loss — only if the replica was also out of sync at the moment of the crash. Otherwise, the full shard is restored with no loss."
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_REPLICA" == "no" ]]; then
    block \
      "Physical segment corruption, NO healthy replica of this shard." \
      "1) If you have a snapshot repo:  POST _snapshot/<repo>/<snapshot>/_restore -d '{\"indices\":\"<INDEX>\"}'\n2) If you have NO snapshot:  kubectl exec -it <es-pod> -- elasticsearch-shard remove-corrupted-data --index <INDEX> --shard-id <N>" \
      "Check whether a snapshot repo exists at all: GET _snapshot/_all. If using remove-corrupted-data, ES MUST be shut down on that node before running the tool." \
      "Option 1 (restore): you only lose data written after the last snapshot. Option 2 (remove-corrupted-data): you PERMANENTLY delete the corrupted documents from that shard — no way back to that data."
  fi

  if [[ "$HAS_CORRUPT" == "no" && "$HAS_UNASSIGNED" == "no" && "$IS_RED" == "no" ]]; then
    say "\nNo clear trace of corruption or unassigned shards was detected in the collected files."
    say "The POD-LAYER check above (step 0) already scanned describe/events for OOMKilled, eviction, volume and probe issues$([[ $K8S_HIT == yes ]] && echo " — and found some; start there" || echo " — none found. Also glance at 01-pod-describe.txt for Node NotReady, which has no single reliable signature")."
  fi
  ;;

# =============================================================================
clickhouse)
  BROKEN="$DIR/10-ch-broken-parts.txt"
  DETACHED="$DIR/11-ch-detached-parts.txt"
  READONLY_REPLICAS="$DIR/12-ch-readonly-replicas.txt"
  LOGS="$DIR/03-logs-previous.txt $DIR/04-logs-current.txt"

  HAS_CORRUPT=$(grep -qiE "cannot read all data|checksum doesn't match|corrupt" $LOGS 2>/dev/null && echo yes || echo no)

  if looks_like_exec_error "$DETACHED" || looks_like_exec_error "$READONLY_REPLICAS"; then
    say "\n!! WARNING: $DETACHED or $READONLY_REPLICAS looks like a kubectl exec error, not real query output."
    say "   The pod was likely unreachable when diag-agent.sh ran (CrashLoopBackOff?). Treating this data as UNKNOWN, not 'no problems found'."
    say "   Re-run diag-agent.sh once the pod is reachable, or check those files by hand before trusting any 'no detached parts / no readonly replicas' conclusion below.\n"
    HAS_DETACHED=unknown
    HAS_READONLY_REPLICA=unknown
  else
    HAS_DETACHED=$([[ -s "$DETACHED" ]] && grep -qv "^Ok\.\|^$" "$DETACHED" 2>/dev/null && echo yes || echo no)
    HAS_READONLY_REPLICA=$([[ -s "$READONLY_REPLICAS" ]] && grep -qv "^Ok\.\|^$" "$READONLY_REPLICAS" 2>/dev/null && echo yes || echo no)
  fi

  if [[ "$HAS_READONLY_REPLICA" == "yes" ]]; then
    block \
      "The replica is in readonly mode (usually means it can't sync with ZooKeeper/Keeper or has lost quorum)." \
      "SYSTEM RESTART REPLICA db.table;" \
      "Check that the ZooKeeper/ClickHouse Keeper cluster is running and reachable from this node (network/DNS)." \
      "No risk to data — it just re-establishes the connection and metadata with Keeper."
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_DETACHED" == "yes" ]]; then
    block \
      "ClickHouse itself detected a broken part and moved it to detached (see 11-ch-detached-parts.txt)." \
      "For ReplicatedMergeTree:  SYSTEM RESTART REPLICA db.table;  (pulls a healthy part from another replica)\nIf it's NOT replicated, and you're sure the part is safe to permanently remove:  ALTER TABLE db.table DROP DETACHED PART '<part_name>';" \
      "Check whether the table is a Replicated* engine (SELECT engine FROM system.tables WHERE name='table'). For DROP DETACHED, first check whether the part contains important data (the partition's time range)." \
      "RESTART REPLICA: no loss if another replica has that part. DROP DETACHED PART: PERMANENTLY deletes that piece of data — no recovery."
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_DETACHED" == "no" ]]; then
    block \
      "Corruption trace in the logs, but the part wasn't automatically detected/detached (maybe it crashed mid-write before CH could isolate it)." \
      "DETACH TABLE db.table;\nATTACH TABLE db.table;" \
      "Make a copy of the table's data directory on disk BEFORE this (cp -r /var/lib/clickhouse/data/<db>/<table> /backup/) — DETACH/ATTACH will try to load all parts and isolate the bad ones itself, but you want a fallback in case something goes wrong." \
      "On ATTACH, CH will move bad parts into detached on its own (as above) — small chance the whole table stays unavailable if the corruption is in the meta files, not in the part itself."
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_DETACHED" == "unknown" ]]; then
    say "\nCorruption trace found in the logs, but 11-ch-detached-parts.txt couldn't be trusted (see warning above)."
    say "Manually run: kubectl exec <pod> -- clickhouse-client -q \"SELECT * FROM system.detached_parts\" once the pod is reachable, then re-run this script."
  fi
  ;;

# =============================================================================
kafka)
  CORRUPT_LINES="$DIR/10-kafka-corruption-lines.txt"
  TOPICS="$DIR/11-kafka-topics-describe.txt"
  LOGS="$DIR/03-logs-previous.txt $DIR/04-logs-current.txt"

  HAS_CORRUPT=$([[ -f "$CORRUPT_LINES" ]] && [[ -s "$CORRUPT_LINES" ]] && echo yes || echo no)

  if looks_like_exec_error "$TOPICS"; then
    say "\n!! WARNING: $TOPICS looks like a kubectl exec error, not a real topic list."
    say "   The pod was likely unreachable when diag-agent.sh ran (CrashLoopBackOff?). Treating RF as UNKNOWN, not 'no RF=1 topics'."
    say "   Re-run diag-agent.sh once the pod is reachable, or run kafka-topics.sh --describe from a different healthy broker.\n"
    HAS_RF1=unknown
  else
    HAS_RF1=$(grep -qE "ReplicationFactor: 1( |$)" "$TOPICS" 2>/dev/null && echo yes || echo no)
  fi

  # Kafka's error usually includes the exact segment file path, e.g.:
  #   CorruptRecordException: ... in /var/lib/kafka/data/<topic>-<partition>/<offset>.log
  # Parse it instead of leaving the operator to guess/reconstruct the path.
  CORRUPT_PATH=""
  if [[ "$HAS_CORRUPT" == "yes" ]]; then
    CORRUPT_PATH=$(grep -oE '/var/lib/kafka/data/[^ ,)]+\.log' "$CORRUPT_LINES" 2>/dev/null | head -n1)
  fi
  if [[ -n "$CORRUPT_PATH" ]]; then
    SEGMENT_BASENAME="${CORRUPT_PATH%.log}"
    REMOVE_CMD="rm -v ${SEGMENT_BASENAME}.log ${SEGMENT_BASENAME}.index ${SEGMENT_BASENAME}.timeindex"
  else
    SEGMENT_BASENAME="/var/lib/kafka/data/<topic>-<partition>/<offset>"
    REMOVE_CMD="# Could not parse the exact segment path from 10-kafka-corruption-lines.txt — check it manually, then:\nrm -v ${SEGMENT_BASENAME}.log ${SEGMENT_BASENAME}.index ${SEGMENT_BASENAME}.timeindex"
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_RF1" != "yes" ]]; then
    block \
      "Corrupt segment detected (see 10-kafka-corruption-lines.txt)$( [[ "$HAS_RF1" == "unknown" ]] && echo ' — replication factor could not be confirmed, see warning above' || echo ', the topic has a replication factor > 1' )." \
      "1) Check which brokers are In-Sync-Replicas for that topic:  kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic <TOPIC>\n2) Stop the broker with the damaged segment (kubectl delete pod or scale down)\n3) ${REMOVE_CMD}\n4) Restart the broker — Kafka will sync the segment from the ISR list" \
      "BEFORE deleting the segment, check that the remaining replicas are actually in ISR (in-sync) — if not, don't touch it until they sync, or you'll lose data on the remaining replicas too." \
      "If the other replicas are healthy and in-sync: no permanent data loss, just temporary broker unavailability while it resyncs."
  fi

  if [[ "$HAS_CORRUPT" == "yes" && "$HAS_RF1" == "yes" ]]; then
    block \
      "Corrupt segment detected, and at least some topics have ReplicationFactor=1 — check whether the AFFECTED topic is specifically the one with RF=1 (11-kafka-topics-describe.txt)." \
      "If the affected topic is RF=1: there's no replica to recover data from.\n${REMOVE_CMD}\nThen restart the broker (loss of messages in that segment is unavoidable)." \
      "Check whether a MirrorMaker/replication to another cluster or an offsite backup of those messages exists — if so, restoring from there is a better option than accepting the loss." \
      "PERMANENT loss of messages from that segment if there's no other copy. After this, urgently raise the replication factor for that topic (kafka-topics.sh --alter --topic <T> --partitions ... or via the reassign-partitions tool) so this doesn't happen again."
  fi

  if [[ "$HAS_CORRUPT" == "no" ]]; then
    say "\nNo clear trace of a corrupt segment was found in the logs. Check 01-pod-describe.txt for OOMKilled/eviction as an alternative cause."
  fi
  ;;

*)
  echo "Unknown type: $TYPE. Use elasticsearch, clickhouse, or kafka."
  exit 1
  ;;
esac

say "\n================================================================"
say "These are suggestions based on heuristics (grepping logs/statuses)."
say "Before any DESTRUCTIVE action (anything marked 'PERMANENT' or 'data loss'):"
say "  1. Make a backup/snapshot of the current disk state if possible."
say "  2. Confirm the prerequisites manually, don't rely solely on this heuristic finding."
say "\nFull report: $OUT"
