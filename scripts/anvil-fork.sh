#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

RPC_URL="${CHAINSTACK_HTTP_URL:-https://bsc-dataseed1.binance.org}"
PORT="${ANVIL_PORT:-8545}"
CHAIN_ID=56

if ! command -v anvil &>/dev/null; then
  echo "ERROR: anvil not found. Install Foundry: https://getfoundry.sh"
  exit 1
fi

echo "Starting Anvil BSC fork..."
echo "  RPC:      $RPC_URL"
echo "  Port:     $PORT"
echo "  Chain ID: $CHAIN_ID"
echo ""

exec anvil \
  --fork-url "$RPC_URL" \
  --port "$PORT" \
  --chain-id "$CHAIN_ID" \
  --gas-price 3000000000 \
  --block-time 1 \
  --accounts 10 \
  --balance 10000
