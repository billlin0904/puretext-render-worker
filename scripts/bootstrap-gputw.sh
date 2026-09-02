#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${PURETEXT_WORKER_REPO_URL:-https://github.com/billlin0904/puretext-render-worker.git}"
INSTALL_DIR="${PURETEXT_WORKER_DIR:-/workspace/puretext-render-worker}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl ffmpeg fontconfig fonts-noto-cjk git tini

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --prune origin
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm ci
npm run build
install -d -m 0755 /var/lib/puretext-render-worker

echo "Worker installed at $INSTALL_DIR"
echo "Start:  $INSTALL_DIR/scripts/gputw-worker.sh start"
echo "Status: $INSTALL_DIR/scripts/gputw-worker.sh status"
echo "Logs:   $INSTALL_DIR/scripts/gputw-worker.sh logs"

