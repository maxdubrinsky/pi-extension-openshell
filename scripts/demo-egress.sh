#!/usr/bin/env bash
# Demo: an agent's bash runs inside an OpenShell sandbox, its egress is denied by
# default, the denial is observed from the gateway, and one narrow policy change
# makes the same command work without restarting anything.
#
# Prerequisites: a gateway (./scripts/dev-gateway.sh up for a throwaway one), pi
# with a configured model, and this package's dependencies (npm install).
#
#   ./scripts/demo-egress.sh              # full demo, then delete the sandbox
#   DEMO_KEEP=1 ./scripts/demo-egress.sh  # keep the sandbox afterwards
#   DEMO_MODEL=provider/model ./scripts/demo-egress.sh

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
export OPENSHELL_GATEWAY=${OPENSHELL_GATEWAY:-http://127.0.0.1:28080}
export DEMO_SANDBOX=${DEMO_SANDBOX:-demo-egress}
PROMPT='You are demonstrating pi + NVIDIA OpenShell. Every bash command you run is executed INSIDE an OpenShell sandbox, not on the host. Do exactly this, in order, using the bash tool for commands:
1. Run: hostname; id -un; head -1 /etc/os-release  (say which machine this is and why it is not the host)
2. Run: wget -q -O /dev/null --timeout=15 https://example.com/ && echo FETCH_OK || echo FETCH_DENIED
3. Call openshell_egress with action denials to see why it was blocked; quote the DENIED reason line and the executable path it names.
4. Call openshell_egress action allow with sandbox '"$DEMO_SANDBOX"', rule web, host example.com, port 443, access read-only, and binaries set to the executable path from step 3.
5. Re-run the exact command from step 2.
6. Report the policy version and the hash change from step 4.
Be concise: after each step one line of what happened.'

MODEL_ARGS=()
if [ -n "${DEMO_MODEL:-}" ]; then
  MODEL_ARGS=(--model "$DEMO_MODEL")
fi

echo "== creating sandbox $DEMO_SANDBOX on $OPENSHELL_GATEWAY"
node "$ROOT/scripts/demo-setup.mjs"

echo
echo "== running the agent (bash routed into the sandbox)"
OPENSHELL_SANDBOX=$DEMO_SANDBOX pi -e "$ROOT/src/index.ts" \
  --no-builtin-tools --no-session \
  --tools bash,openshell_egress,openshell_status \
  "${MODEL_ARGS[@]}" -p "$PROMPT"

if [ "${DEMO_KEEP:-0}" != "1" ]; then
  echo
  echo "== cleaning up"
  node "$ROOT/scripts/demo-setup.mjs" --delete
else
  echo
  echo "sandbox $DEMO_SANDBOX kept; inspect it with:"
  echo "  OPENSHELL_SANDBOX=$DEMO_SANDBOX pi -e $ROOT/src/index.ts"
  echo "remove it with: node $ROOT/scripts/demo-setup.mjs --delete"
fi
