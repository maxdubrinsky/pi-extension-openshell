#!/usr/bin/env bash
# Throwaway local OpenShell gateway for developing and testing this extension.
#
# Runs the published gateway image with the Docker compute driver, TLS disabled,
# and unauthenticated access enabled, so the SDK can connect over loopback with
# no certificates. Everything lives under ${OPENSHELL_DEV_DIR:-~/openshell}.
# Nothing is installed on the host.
#
#   ./scripts/dev-gateway.sh up      # create or recreate, then print the URL
#   ./scripts/dev-gateway.sh down    # remove the container (state is kept)
#   ./scripts/dev-gateway.sh reset   # remove the container and its state
#   ./scripts/dev-gateway.sh logs    # follow gateway logs
#
# The gateway listens on 28080 (gRPC) and 28081 (health); change the ports below
# if those are taken. Sandbox containers call back to host.openshell.internal on
# the same port, so the published and internal ports must match.

set -euo pipefail

NAME=openshell-gateway-test
HOST_PORT=${OPENSHELL_DEV_PORT:-28080}
HEALTH_PORT=${OPENSHELL_DEV_HEALTH_PORT:-28081}
DIR=${OPENSHELL_DEV_DIR:-$HOME/openshell}
SUPERVISOR=$DIR/supervisor/openshell-supervisor
TLS=$DIR/tls
STATE=$DIR/state
CONFIG_FILE=$DIR/gateway-test.toml
IMAGE=quay.io/ai-openshell/gateway:latest
SUPERVISOR_IMAGE=quay.io/ai-openshell/supervisor:latest
# The gateway container runs as this uid and must own its state and key material.
GATEWAY_UID=1000

docker_gid() {
  stat -c '%g' /var/run/docker.sock
}

own_for_gateway() {
  if [ "$(id -u)" = "0" ]; then
    chown -R "$GATEWAY_UID:$GATEWAY_UID" "$@"
  elif [ "$(stat -c '%u' "$1")" != "$GATEWAY_UID" ]; then
    sudo -n chown -R "$GATEWAY_UID:$GATEWAY_UID" "$@" 2>/dev/null || true
  fi
}

prepare() {
  mkdir -p "$DIR/supervisor" "$TLS" "$STATE"
  if [ ! -x "$SUPERVISOR" ]; then
    echo "extracting the sandbox supervisor binary"
    docker pull -q "$SUPERVISOR_IMAGE" >/dev/null
    local tmp
    tmp=$(docker create "$SUPERVISOR_IMAGE")
    docker cp "$tmp:/openshell-supervisor" "$SUPERVISOR"
    docker rm "$tmp" >/dev/null
    chmod +x "$SUPERVISOR"
  fi

  if [ ! -f "$DIR/tls.ready" ]; then
    echo "generating the sandbox launch-signing bundle"
    # generate-certs chmods its output, so it has to run as a user that owns the mount.
    docker run --rm --user 0 -v "$TLS:/out" "$IMAGE" generate-certs --output-dir /out >/dev/null
    own_for_gateway "$TLS" "$STATE"
    touch "$DIR/tls.ready"
  fi

  cat >"$CONFIG_FILE" <<EOF
[openshell]
version = 2

[openshell.gateway]
bind_address         = "0.0.0.0:$HOST_PORT"
health_bind_address  = "0.0.0.0:$HEALTH_PORT"
metrics_bind_address = "0.0.0.0:29090"
log_level            = "info"

[openshell.gateway.auth]
allow_unauthenticated_users = true
EOF
}

up() {
  prepare
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    --group-add "$(docker_gid)" \
    -p "$HOST_PORT:$HOST_PORT" -p "$HEALTH_PORT:8081" \
    -v "$STATE:/var/openshell" \
    -v "$TLS:/var/openshell/tls:ro" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$SUPERVISOR:$SUPERVISOR:ro" \
    -v "$CONFIG_FILE:/etc/openshell/gateway.toml:ro" \
    -e HOME=/var/openshell \
    -e XDG_STATE_HOME=/var/openshell/state \
    -e OPENSHELL_LOCAL_TLS_DIR=/var/openshell/tls \
    -e OPENSHELL_GATEWAY_CONFIG=/etc/openshell/gateway.toml \
    -e OPENSHELL_COMPUTE_DRIVER=docker \
    -e OPENSHELL_GRPC_ENDPOINT="http://host.openshell.internal:$HOST_PORT" \
    -e OPENSHELL_DOCKER_SUPERVISOR_BIN="$SUPERVISOR" \
    -e OPENSHELL_DB_URL=sqlite:/var/openshell/openshell.db \
    -e OPENSHELL_DISABLE_TLS=true \
    "$IMAGE" --bind-address 0.0.0.0 --port "$HOST_PORT" >/dev/null
  sleep 10
  if docker ps --filter "name=$NAME" --format '{{.Status}}' | grep -q '^Up'; then
    echo "gateway: http://127.0.0.1:$HOST_PORT"
    echo
    echo "run the live test with:"
    echo "  OPENSHELL_TEST_GATEWAY=http://127.0.0.1:$HOST_PORT node --test test/live.test.ts"
  else
    echo "gateway failed to start:" >&2
    docker logs "$NAME" 2>&1 | tail -20 >&2
    exit 1
  fi
}

down() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "removed $NAME (state kept in $STATE)"
}

reset() {
  down
  sudo -n rm -rf "$STATE" 2>/dev/null || rm -rf "$STATE" 2>/dev/null || true
  echo "state reset"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  logs) docker logs -f "$NAME" ;;
  *) echo "usage: $0 [up|down|reset|logs]" >&2; exit 2 ;;
esac
