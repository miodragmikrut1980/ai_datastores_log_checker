#!/usr/bin/env bash
#
# db-incident.sh — Orchestrator: runs diag-agent.sh then recommend-agent.sh in one go.
#
# USAGE:
#   ./db-incident.sh <namespace> <pod-name> <elasticsearch|clickhouse|kafka|auto>
#
# EXAMPLE:
#   ./db-incident.sh production es-data-0 elasticsearch
#
# The script expects diag-agent.sh and recommend-agent.sh to be in the same folder (or in PATH).

set -uo pipefail

NAMESPACE="${1:-}"
POD="${2:-}"
TYPE="${3:-auto}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$NAMESPACE" || -z "$POD" ]]; then
  echo "Usage: $0 <namespace> <pod-name> [elasticsearch|clickhouse|kafka|auto]"
  exit 1
fi

echo ">>> Step 1/2: collecting diagnostics ($POD in $NAMESPACE)..."
"$SCRIPT_DIR/diag-agent.sh" "$NAMESPACE" "$POD" "$TYPE"

# Find the folder diag-agent.sh just created (most recent for this pod name)
REPORT_DIR=$(ls -dt ./diag-report-"${POD}"-* 2>/dev/null | head -n1)

if [[ -z "$REPORT_DIR" ]]; then
  echo "ERROR: diag-report folder not found, aborting."
  exit 1
fi

# If it was "auto", find out the actually detected type from summary.txt so recommend-agent knows what to do
if [[ "$TYPE" == "auto" ]]; then
  DETECTED=$(grep -oE "elasticsearch|clickhouse|kafka" "$REPORT_DIR/summary.txt" | head -n1)
  TYPE="${DETECTED:-unknown}"
fi

echo ""
echo ">>> Step 2/2: generating suggested fixes (type: $TYPE)..."
if [[ "$TYPE" == "unknown" ]]; then
  echo "Type could not be auto-detected - run manually:"
  echo "  $SCRIPT_DIR/recommend-agent.sh $REPORT_DIR <elasticsearch|clickhouse|kafka>"
  exit 0
fi

"$SCRIPT_DIR/recommend-agent.sh" "$REPORT_DIR" "$TYPE"

echo ""
echo "=================================================================="
echo "Full report: $REPORT_DIR"
echo "  - summary.txt          -> diagnostics and raw findings"
echo "  - recommendations.txt  -> suggested fixes + consequences"
echo "=================================================================="
