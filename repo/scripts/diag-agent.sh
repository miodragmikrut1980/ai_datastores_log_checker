#!/usr/bin/env bash
#
# diag-agent.sh — Read-only diagnostic agent for Instana self-hosted datastore incidents
#
# PURPOSE:
#   When a pod crashes (crash loop, suspected corruption), run this script BEFORE any
#   manual intervention. It ONLY READS state (kubectl describe/logs, SQL/HTTP health
#   queries, disk checks) and writes it all into one report. It does not delete files,
#   does not restart anything, does not run destructive recovery commands.
#
# HOW TO RUN IT:
#   chmod +x diag-agent.sh
#   ./diag-agent.sh <namespace> <pod-name> <type>
#
#   <type> is one of: instana | elasticsearch | clickhouse | kafka | auto
#   If you pass "auto", the script tries to guess the type from the pod/image name.
#
# EXAMPLE:
#   ./diag-agent.sh production es-data-0 elasticsearch
#   ./diag-agent.sh production ch-shard1-0 clickhouse
#   ./diag-agent.sh production kafka-broker-2 kafka
#
# REQUIREMENTS:
#   - kubectl configured with cluster access (kubectl config current-context)
#   - enough permissions to run 'kubectl exec' and 'kubectl logs' in the given namespace
#
# OUTPUT:
#   Creates a ./diag-report-<pod>-<timestamp>/ folder with all raw data
#   and a summary.txt file at the top with findings and a suggested next step.

set -uo pipefail

NAMESPACE="${1:-}"
POD="${2:-}"
TYPE="${3:-auto}"

if [[ -z "$NAMESPACE" || -z "$POD" ]]; then
  echo "Usage: $0 <namespace> <pod-name> [instana|elasticsearch|clickhouse|kafka|auto]"
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
OUTDIR="./diag-report-${POD}-${TS}"
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/summary.txt"

log() { echo "$@" | tee -a "$SUMMARY"; }
section() { echo -e "\n===== $1 =====" | tee -a "$SUMMARY"; }

log "Diagnostic report"
log "Namespace: $NAMESPACE   Pod: $POD   Time: $(date)"
log "-----------------------------------------------------"

# ---------------------------------------------------------------------------
# 0. Basic pod state (always, for all types)
# ---------------------------------------------------------------------------
section "0. Basic pod state"

kubectl -n "$NAMESPACE" get pod "$POD" -o wide > "$OUTDIR/00-pod-status.txt" 2>&1
kubectl -n "$NAMESPACE" describe pod "$POD" > "$OUTDIR/01-pod-describe.txt" 2>&1
kubectl -n "$NAMESPACE" get events --sort-by='.lastTimestamp' > "$OUTDIR/02-events.txt" 2>&1

RESTART_COUNT=$(kubectl -n "$NAMESPACE" get pod "$POD" -o jsonpath='{.status.containerStatuses[0].restartCount}' 2>/dev/null || echo "N/A")
LAST_STATE=$(kubectl -n "$NAMESPACE" get pod "$POD" -o jsonpath='{.status.containerStatuses[0].lastState}' 2>/dev/null || echo "N/A")

log "Restart count: $RESTART_COUNT"
log "Last container state (raw): see $OUTDIR/01-pod-describe.txt"

# ---------------------------------------------------------------------------
# 0a. Instana self-hosted context (best-effort, read-only)
# ---------------------------------------------------------------------------
section "0a. Instana self-hosted context"

if command -v stanctl >/dev/null 2>&1; then
  stanctl status > "$OUTDIR/00a-stanctl-status.txt" 2>&1
  stanctl unit status > "$OUTDIR/00b-stanctl-unit-status.txt" 2>&1
  log "stanctl status saved: $OUTDIR/00a-stanctl-status.txt"
  log "stanctl unit status saved: $OUTDIR/00b-stanctl-unit-status.txt"
else
  log "NOTE: stanctl not found in PATH. If this is Instana self-hosted, ask the customer for: stanctl status && stanctl unit status"
fi

kubectl get ns > "$OUTDIR/00c-k8s-namespaces.txt" 2>&1
kubectl -n "$NAMESPACE" get statefulset,pod,pvc -o wide > "$OUTDIR/00d-instana-datastore-resources.txt" 2>&1

if grep -qiE "instana-clickhouse|clickhouse" "$OUTDIR/00-pod-status.txt" "$OUTDIR/01-pod-describe.txt" 2>/dev/null; then
  log "Instana datastore hint: ClickHouse namespace/pod. Likely impact: metrics/query path degraded."
elif grep -qiE "instana-kafka|kafka" "$OUTDIR/00-pod-status.txt" "$OUTDIR/01-pod-describe.txt" 2>/dev/null; then
  log "Instana datastore hint: Kafka namespace/pod. Likely impact: ingest/async processing risk."
elif grep -qiE "instana-elasticsearch|elasticsearch|elastic" "$OUTDIR/00-pod-status.txt" "$OUTDIR/01-pod-describe.txt" 2>/dev/null; then
  log "Instana datastore hint: Elasticsearch namespace/pod. Likely impact: search/query/backend feature degradation."
fi

# Logs BEFORE the last restart - this is the most important thing for finding the cause
kubectl -n "$NAMESPACE" logs "$POD" --previous --tail=500 > "$OUTDIR/03-logs-previous.txt" 2>&1
kubectl -n "$NAMESPACE" logs "$POD" --tail=200 > "$OUTDIR/04-logs-current.txt" 2>&1

if [[ -s "$OUTDIR/03-logs-previous.txt" ]]; then
  log "Logs from before the restart saved: $OUTDIR/03-logs-previous.txt"
else
  log "NOTE: no logs from a previous run (pod hasn't restarted yet, or logs were rotated)."
fi

# ---------------------------------------------------------------------------
# 0b. Disk / resources (a common cause of corruption: full disk / OOM mid-write)
# ---------------------------------------------------------------------------
section "0b. Disk and resources"

kubectl -n "$NAMESPACE" get pvc > "$OUTDIR/05-pvc.txt" 2>&1
kubectl -n "$NAMESPACE" top pod "$POD" --containers > "$OUTDIR/06-resource-usage.txt" 2>&1

# If the pod is currently up, try to check disk usage inside it
if kubectl -n "$NAMESPACE" exec "$POD" -- df -h > "$OUTDIR/07-disk-df.txt" 2>&1; then
  log "Disk usage saved: $OUTDIR/07-disk-df.txt"
  if grep -qE '(9[5-9]|100)%' "$OUTDIR/07-disk-df.txt"; then
    log "!! WARNING: disk is >=95% full on one of the partitions - a very common cause of corruption."
  fi
else
  log "NOTE: pod is currently not reachable for exec (CrashLoopBackOff?) - we'll check disk via the node if possible."
fi

# ---------------------------------------------------------------------------
# 1. Auto-detect the type if "auto"
# ---------------------------------------------------------------------------
if [[ "$TYPE" == "auto" ]]; then
  IMG=$(kubectl -n "$NAMESPACE" get pod "$POD" -o jsonpath='{.spec.containers[0].image}' 2>/dev/null || echo "")
  case "$IMG" in
    *instana*clickhouse*|*clickhouse*) TYPE="clickhouse" ;;
    *instana*kafka*|*kafka*) TYPE="kafka" ;;
    *instana*elasticsearch*|*elasticsearch*|*elastic*) TYPE="elasticsearch" ;;
    *) TYPE="unknown" ;;
  esac
  log "Auto-detected type based on the image ($IMG): $TYPE"
fi

if [[ "$TYPE" == "instana" ]]; then
  IMG=$(kubectl -n "$NAMESPACE" get pod "$POD" -o jsonpath='{.spec.containers[0].image}' 2>/dev/null || echo "")
  HINT="$NAMESPACE $POD $IMG"
  case "$HINT" in
    *clickhouse*) TYPE="clickhouse" ;;
    *kafka*) TYPE="kafka" ;;
    *elasticsearch*|*elastic*) TYPE="elasticsearch" ;;
    *) TYPE="unknown" ;;
  esac
  log "Instana mode selected. Datastore detected from namespace/pod/image ($HINT): $TYPE"
fi

# ---------------------------------------------------------------------------
# 2. Type-specific diagnostics
# ---------------------------------------------------------------------------
case "$TYPE" in

  elasticsearch)
    section "Elasticsearch diagnostics"

    # Health and shard status - try locally via exec+curl (works if the pod is up)
    kubectl -n "$NAMESPACE" exec "$POD" -- curl -s "localhost:9200/_cluster/health?pretty" \
      > "$OUTDIR/10-es-cluster-health.txt" 2>&1
    kubectl -n "$NAMESPACE" exec "$POD" -- curl -s "localhost:9200/_cat/shards?v" \
      > "$OUTDIR/11-es-shards.txt" 2>&1
    kubectl -n "$NAMESPACE" exec "$POD" -- curl -s "localhost:9200/_cluster/allocation/explain?pretty" \
      > "$OUTDIR/12-es-allocation-explain.txt" 2>&1

    if grep -qi "red" "$OUTDIR/10-es-cluster-health.txt" 2>/dev/null; then
      log "!! Cluster status is RED - there are unavailable primary shards."
    fi

    if grep -qiE "corrupt|CorruptIndexException|checksum" "$OUTDIR/03-logs-previous.txt" "$OUTDIR/04-logs-current.txt" 2>/dev/null; then
      log "!! Found a 'corrupt/checksum' trace in the logs - likely physical corruption of a Lucene segment."
      log "   Next step: check whether the shard has a healthy replica (11-es-shards.txt)."
      log "   If there's NO replica but you have a snapshot repo: restoring from the snapshot is safest."
      log "   If there's NO replica and NO snapshot: elasticsearch-shard remove-corrupted-data (loses part of the data - do not run this automatically, it's a manual step)."
    fi
    ;;

  clickhouse)
    section "ClickHouse diagnostics"

    if kubectl -n "$NAMESPACE" exec "$POD" -- clickhouse-client -q \
      "SELECT database, table, name, bytes_on_disk, is_readonly FROM system.parts WHERE is_readonly OR bytes_on_disk = 0 FORMAT PrettyCompact" \
      > "$OUTDIR/10-ch-broken-parts.txt" 2>&1; then
      log "Broken/readonly parts query saved: $OUTDIR/10-ch-broken-parts.txt"
    else
      log "!! NOTE: 'kubectl exec ... clickhouse-client' failed - the pod is likely not reachable (CrashLoopBackOff?)."
      log "   $OUTDIR/10-ch-broken-parts.txt contains the raw error, not query results - don't treat an empty-looking file as 'no problems found'."
      log "   If the pod won't stay up long enough for exec, you'll need the previous logs (03-logs-previous.txt) as the primary evidence instead."
    fi

    kubectl -n "$NAMESPACE" exec "$POD" -- clickhouse-client -q \
      "SELECT * FROM system.detached_parts FORMAT PrettyCompact" \
      > "$OUTDIR/11-ch-detached-parts.txt" 2>&1

    kubectl -n "$NAMESPACE" exec "$POD" -- clickhouse-client -q \
      "SELECT table, replica_name, is_readonly, absolute_delay FROM system.replicas WHERE is_readonly FORMAT PrettyCompact" \
      > "$OUTDIR/12-ch-readonly-replicas.txt" 2>&1

    if grep -qiE "cannot read all data|checksum doesn't match|corrupt" \
       "$OUTDIR/03-logs-previous.txt" "$OUTDIR/04-logs-current.txt" 2>/dev/null; then
      log "!! Found a corruption trace in the ClickHouse logs (checksum/cannot read all data)."
      log "   Next step: check 11-ch-detached-parts.txt - CH has likely already isolated the bad part on its own."
      log "   If it's a ReplicatedMergeTree: SYSTEM RESTART REPLICA on that table will pull a healthy part from another replica."
      log "   If it's NOT replicated: a restore from backup will be needed for that part/partition."
    fi
    ;;

  kafka)
    section "Kafka diagnostics"

    if grep -qiE "corrupt|CorruptRecordException|InvalidOffsetException|OutOfOrderSequenceException" \
       "$OUTDIR/03-logs-previous.txt" "$OUTDIR/04-logs-current.txt" 2>/dev/null; then
      log "!! Found a corrupt segment trace in the Kafka logs."
      grep -iE "corrupt|CorruptRecordException|InvalidOffsetException" \
        "$OUTDIR/03-logs-previous.txt" "$OUTDIR/04-logs-current.txt" 2>/dev/null \
        > "$OUTDIR/10-kafka-corruption-lines.txt"
      log "   Detailed lines: $OUTDIR/10-kafka-corruption-lines.txt"
      # Kafka's own error message usually includes the exact segment file path
      # (e.g. ".../CorruptRecordException: ... in /var/lib/kafka/data/<topic>-<partition>/<offset>.log")
      # - pull that out so the next step doesn't need to be reconstructed by hand.
      CORRUPT_PATH=$(grep -oE '/var/lib/kafka/data/[^ ,)]+\.log' "$OUTDIR/10-kafka-corruption-lines.txt" 2>/dev/null | head -n1)
      if [[ -n "$CORRUPT_PATH" ]]; then
        log "   Exact segment file (parsed from the error): $CORRUPT_PATH"
      else
        log "   Could not parse the exact segment path from the log line - check 10-kafka-corruption-lines.txt manually; it's usually under /var/lib/kafka/data/<topic>-<partition>/."
      fi
      log "   Next step: check the replication factor of that topic (below)."
      log "   If RF>1 and the other replicas are healthy: it's safe for the broker to rebuild the segment from the replicas."
      log "   If RF=1: risk of permanent data loss for that segment - be careful."
    fi

    # List of topics and RF - this often reveals that RF=1 was the root cause
    if kubectl -n "$NAMESPACE" exec "$POD" -- kafka-topics.sh --bootstrap-server localhost:9092 --describe \
      > "$OUTDIR/11-kafka-topics-describe.txt" 2>&1; then
      log "Topic describe saved: $OUTDIR/11-kafka-topics-describe.txt"
    else
      log "!! NOTE: 'kubectl exec ... kafka-topics.sh' failed - the pod is likely not reachable (CrashLoopBackOff?)."
      log "   $OUTDIR/11-kafka-topics-describe.txt contains the raw error, not a real topic list - don't treat it as 'no RF=1 topics found'."
      log "   If the pod won't stay up long enough for exec, try running kafka-topics.sh against the cluster from a DIFFERENT healthy broker/pod instead."
    fi

    if grep -qE "ReplicationFactor: 1( |$)" "$OUTDIR/11-kafka-topics-describe.txt" 2>/dev/null; then
      log "!! Found topics with ReplicationFactor=1 - that's a structural risk for future corruption."
    fi
    ;;

  *)
    section "Unknown/unsupported type"
    log "Type '$TYPE' not recognized. Supported: elasticsearch, clickhouse, kafka."
    log "Basic data (logs, describe, events) was still saved to $OUTDIR."
    log ""
    log "Manual next steps since auto-detection couldn't tell what this is:"
    log "  1. Check the container image: kubectl -n $NAMESPACE get pod $POD -o jsonpath='{.spec.containers[0].image}'"
    log "  2. Check 03-logs-previous.txt for the actual application name/error (grep -i 'error\\|exception\\|fatal' 03-logs-previous.txt | head -20)"
    log "  3. Check 01-pod-describe.txt for OOMKilled / Node NotReady / liveness probe failures as a generic first cause to rule out"
    log "  4. Re-run this script with the correct type once you know it: $0 $NAMESPACE $POD <elasticsearch|clickhouse|kafka>"
    ;;
esac

# ---------------------------------------------------------------------------
# 3. Final summary
# ---------------------------------------------------------------------------
section "Done"
log "Full report saved to: $OUTDIR"
log "This is READ-ONLY diagnostics - nothing was changed or deleted."
log "Next step: read summary.txt, then decide on a specific recovery action (manually, with a backup before every destructive command)."

echo ""
echo "Done. See: $SUMMARY"
