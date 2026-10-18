#!/usr/bin/env bash
# Runs two concurrent real OpenCode V2 sessions against e2e/project with the plugin loaded.
# Usage: e2e/run.sh /path/to/opencode2
set -euo pipefail
OC="${1:?path to opencode2 binary}"
# `pwd -W` gives a Windows path under Git Bash, which the native opencode binary needs.
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
PROJECT="$ROOT/e2e/project"
SANDBOX="$(mktemp -d)"
export XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" XDG_STATE_HOME="$SANDBOX/state" XDG_CACHE_HOME="$SANDBOX/cache"
export PORT=18080

rm -rf "$PROJECT/.opencode/context-inspector"
cat > "$PROJECT/opencode.jsonc" <<JSON
{
  "model": "mock/scripted",
  "plugins": ["$ROOT"],
  "providers": {
    "mock": {
      "name": "Scripted mock",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$PORT/v1", "apiKey": "x" },
      "models": { "scripted": { "modelID": "scripted", "capabilities": { "tools": true, "input": ["text"], "output": ["text"] }, "limit": { "context": 32768, "output": 4096 } } }
    }
  }
}
JSON

node "$ROOT/e2e/mock-llm.mjs" & MOCK=$!
trap 'kill $MOCK 2>/dev/null || true; "$OC" service stop >/dev/null 2>&1 || true' EXIT
sleep 1
cd "$PROJECT"
"$OC" run --standalone --auto --title A "SCENARIO-A read the context" & A=$!
"$OC" run --standalone --auto --title B "SCENARIO-B read the context" & B=$!
wait $A $B
echo "--- records ---"
for f in .opencode/context-inspector/*.jsonl; do echo "# $f"; cat "$f"; done
