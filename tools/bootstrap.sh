#!/usr/bin/env bash
#
# One command to get from a fresh clone to a running app.
#
#   ./tools/bootstrap.sh && npm run dev
#
# Why this exists: the toolchain this project needs — Node 22 and a Playwright
# chromium build — is roughly 230 MB. Storing that inside the working directory
# doubles the size of every backup and blows through workspace quotas, so it is
# installed to a directory *outside* the project instead. Nothing here belongs in
# version control; the script is the thing that is version-controlled.
#
# Override the install root with TOOLS_DIR=/somewhere ./tools/bootstrap.sh
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.20.0}"
TOOLS_DIR="${TOOLS_DIR:-/opt/kotoba-tools}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- tools location
if ! mkdir -p "$TOOLS_DIR" 2>/dev/null; then
  say "$TOOLS_DIR is not writable; falling back to \$HOME/.kotoba-tools"
  TOOLS_DIR="$HOME/.kotoba-tools"
  mkdir -p "$TOOLS_DIR"
fi

# ---------------------------------------------------------------- node 22
# Wrangler 4.x refuses Node 20, so bring our own rather than depending on the
# system one being new enough.
NODE_BIN="$TOOLS_DIR/node22/bin"
if [ ! -x "$NODE_BIN/node" ] || ! "$NODE_BIN/node" -v >/dev/null 2>&1; then
  say "installing Node $NODE_VERSION → $TOOLS_DIR/node22"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  rm -rf "$TOOLS_DIR/node22"
  mv "$tmp/node-v${NODE_VERSION}-linux-x64" "$TOOLS_DIR/node22"
  rm -rf "$tmp"
else
  say "Node $("$NODE_BIN/node" -v) already at $TOOLS_DIR/node22"
fi
export PATH="$NODE_BIN:$PATH"

# ---------------------------------------------------------------- deps
cd "$PROJECT_DIR"
if [ ! -d node_modules ]; then
  say "installing npm dependencies"
  npm ci --silent || npm install --silent
else
  say "node_modules present"
fi

# ---------------------------------------------------------------- browsers
# Only needed for the visual QA harnesses (npm run shots / npm run audit).
export PLAYWRIGHT_BROWSERS_PATH="$TOOLS_DIR/pw-browsers"
if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1243" ]; then
  say "installing Playwright chromium → $PLAYWRIGHT_BROWSERS_PATH"
  npx playwright install chromium >/dev/null 2>&1 || say "  (skipped — run 'npx playwright install chromium' when you want the visual QA)"
else
  say "chromium already installed"
fi

# ---------------------------------------------------------------- done
cat <<EOF

  Ready.

    export PATH="$NODE_BIN:\$PATH"
    export PLAYWRIGHT_BROWSERS_PATH="$TOOLS_DIR/pw-browsers"

    npm run dev        # http://localhost:8787
    npm run check      # tsc --noEmit
    npm run shots      # screenshots → shots/   (git-ignored)
    npm run audit      # measured contrast / sizing report

EOF
