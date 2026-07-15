#!/usr/bin/env bash
# Idempotent install of the `sunny` systemd user service — the process supervisor
# for the unified app (build once, then serve .output). Replaces devbox supervision
# (2026-07-15 snny.ai migration): sunny's only public name is https://snny.ai via
# the dedicated tunnel (setup-snny-tunnel.sh); no devbox dependency remains.
#
# Ops crib (replaces the devbox verbs):
#   restart (deploy):  systemctl --user restart sunny
#   logs:              journalctl --user -u sunny -f
#   status:            systemctl --user status sunny
#
# Safe to re-run; does NOT start/restart the service (deploys are always an
# explicit, human-approved restart — in-flight durable runs die with the process).
set -euo pipefail

REPO_DIR="${SUNNY_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${SUNNY_NODE_BIN:-/home/tivona/.nvm/versions/node/v24.16.0/bin}"
UNIT_FILE="${HOME}/.config/systemd/user/sunny.service"

mkdir -p "$(dirname "${UNIT_FILE}")"
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=Sunny unified app (build + serve .output) at https://snny.ai
After=network-online.target

[Service]
WorkingDirectory=${REPO_DIR}
Environment=PATH=${NODE_BIN}:/home/tivona/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NITRO_VITE=1
Environment=SUNNY_TEST_CHANNEL=1
# The snny tunnel ingress targets this port (setup-snny-tunnel.sh); devbox used to
# inject it, now the unit owns it.
Environment=PORT=${SUNNY_PORT:-8789}
ExecStart=/usr/bin/env bash -lc 'node --env-file=.env node_modules/vite/bin/vite.js build --config vite.config.unified.ts && exec node --env-file=.env .output/server/index.mjs'
Restart=always
RestartSec=5
# The vite build phase needs a beat; don't let systemd flap-kill it.
TimeoutStartSec=300

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable sunny.service
echo "unit installed + enabled (not started): ${UNIT_FILE}"
echo "cutover:  devbox rm sunny && systemctl --user start sunny && journalctl --user -u sunny -f"
