#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "  Insurance Insight Nexus Pre-Push Verification Suite     "
echo "=========================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo ""
echo "[1/4] Running Frontend Lint (Oxlint)..."
cd "$REPO_ROOT/frontend"
npm run lint

echo ""
echo "[2/4] Running Frontend Production Build..."
cd "$REPO_ROOT/frontend"
npm run build

echo ""
echo "[3/4] Running Backend Code Style (Ruff)..."
cd "$REPO_ROOT/backend"
if command -v ruff &>/dev/null; then
  ruff check .
  echo "Backend Ruff check passed."
else
  echo "Ruff not found locally; will run in CI."
fi

echo ""
echo "=========================================================="
echo "  Pre-Push Validation Succeeded! Safe to commit and push. "
echo "=========================================================="
