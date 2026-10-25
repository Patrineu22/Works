#!/usr/bin/env bash
# FreeCode installer for macOS / Linux
#
#   curl -fsSL https://raw.githubusercontent.com/Patrineu22/Works/main/install.sh | bash
#
# or from a clone:  ./install.sh
set -euo pipefail

GREEN='\033[38;2;0;255;136m'
RESET='\033[0m'
say() { printf "%b\n" "${GREEN}$*${RESET}"; }

say ""
say "  FREECODE - green #00FF88 on #0A0A0A - keyless free forever"
say ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org (or your package manager)." >&2
  exit 1
fi
NODE_MAJOR="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $(node --version) is too old - FreeCode needs 18 or newer." >&2
  exit 1
fi

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"

if [ -f "$SELF_DIR/bin/freecode.mjs" ]; then
  ROOT="$SELF_DIR"
  say "Installing from this checkout: $ROOT"
else
  ROOT="${FREECODE_HOME:-$HOME/.local/share/freecode}"
  say "Fetching FreeCode into $ROOT ..."
  mkdir -p "$ROOT"
  TMP="$(mktemp -d)"
  curl -fsSL https://codeload.github.com/Patrineu22/Works/tar.gz/refs/heads/main | tar -xz -C "$TMP"
  cp -R "$TMP"/Works-main/. "$ROOT"/
  rm -rf "$TMP"
fi

mkdir -p "$ROOT/bin"
LAUNCHER="$ROOT/bin/freecode"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/bin/freecode.mjs" "\$@"
EOF
chmod +x "$LAUNCHER"

TARGET_DIR="${FREECODE_BIN:-$HOME/.local/bin}"
mkdir -p "$TARGET_DIR"
ln -sf "$LAUNCHER" "$TARGET_DIR/freecode"

say "  launcher : $TARGET_DIR/freecode"
say "  version  : $(node "$ROOT/bin/freecode.mjs" --version)"
case ":$PATH:" in
  *":$TARGET_DIR:"*) say "  PATH     : ok" ;;
  *) say "  PATH     : add this line to ~/.bashrc or ~/.zshrc"
     say "             export PATH=\"\$PATH:$TARGET_DIR\"" ;;
esac

say ""
say "Try it:  freecode --help   |   freecode --agent kai   |   freecode --check"
say ""
