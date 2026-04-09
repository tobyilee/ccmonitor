#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${HOME}/.bun/bin"
BIN_NAME="ccmonitor"

cd "$SCRIPT_DIR"

echo "Building claude-monitor..."
bun run build

echo "Installing to ${INSTALL_DIR}/${BIN_NAME}..."
cp dist/claude-monitor "${INSTALL_DIR}/${BIN_NAME}"
chmod +x "${INSTALL_DIR}/${BIN_NAME}"

echo "Done. Run '${BIN_NAME}' to start the monitor."
