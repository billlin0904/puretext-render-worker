#!/usr/bin/env bash
# Keep src/renderer/subtitleCanvas.ts identical to the PureText shared layout
# core. The two trees may only differ by the canvas context type: the browser
# build targets CanvasRenderingContext2D, the worker targets @napi-rs/canvas.
#
#   sync-subtitle-canvas.sh check   verify both copies agree (exit 1 if not)
#   sync-subtitle-canvas.sh pull    copy the shared lib over the worker's vendored copy
#
# The shared lib is canonical. Once @workspace/subtitle-canvas is published as a
# versioned package this script — and the vendored copy — should both go away.
set -euo pipefail

MAIN_REPO="${PURETEXT_MAIN_REPO:-F:/Source/puretext/puretext}"
SOURCE="$MAIN_REPO/lib/subtitle-canvas/src/index.ts"
TARGET="$(cd "$(dirname "$0")/.." && pwd)/src/renderer/subtitleCanvas.ts"
MODE="${1:-check}"

if [ ! -f "$SOURCE" ]; then
  echo "skip: shared lib not found at $SOURCE" >&2
  echo "      set PURETEXT_MAIN_REPO to the PureText checkout to enable this check." >&2
  exit 0
fi

# Shared lib -> worker: swap the context type and append the napi-rs import.
render_expected() {
  # '#' delimits the expression because the TypeScript union contains '|'.
  sed -e 's#^type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;$#type CanvasContext = SKRSContext2D;#' "$SOURCE"
  printf '\nimport type { SKRSContext2D } from "@napi-rs/canvas";\n'
}

EXPECTED="$(mktemp)"
trap 'rm -f "$EXPECTED"' EXIT
render_expected > "$EXPECTED"

case "$MODE" in
  check)
    if diff --strip-trailing-cr -u "$EXPECTED" "$TARGET" > /dev/null; then
      echo "subtitleCanvas.ts is in sync with $SOURCE"
    else
      echo "subtitleCanvas.ts has diverged from the shared layout core:" >&2
      diff --strip-trailing-cr -u "$EXPECTED" "$TARGET" >&2 || true
      echo >&2
      echo "Run 'scripts/sync-subtitle-canvas.sh pull' after landing the change in the shared lib." >&2
      exit 1
    fi
    ;;
  pull)
    cp "$EXPECTED" "$TARGET"
    echo "updated $TARGET from $SOURCE"
    ;;
  *)
    echo "Usage: $0 {check|pull}" >&2
    exit 2
    ;;
esac
