#!/usr/bin/env bash
# End-to-end test: a real OpenCode V2 binary runs six scripted sessions concurrently against a copy of
# e2e/project with this plugin loaded, then the recorded data is asserted. Only the LLM is scripted
# (e2e/mock-llm.mjs), so no model credentials are needed.
#
# Usage: e2e/run.sh /path/to/opencode2      (or OPENCODE_BIN=/path/to/opencode2 e2e/run.sh)
# Exit status: 0 only if every session ran and every assertion held.
set -euo pipefail

OC="${1:-${OPENCODE_BIN:-}}"
if [ -z "$OC" ]; then
  echo "usage: e2e/run.sh /path/to/opencode2 (or set OPENCODE_BIN)" >&2
  exit 2
fi
command -v "$OC" >/dev/null 2>&1 || [ -x "$OC" ] || { echo "e2e: OpenCode binary not found: $OC" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "e2e: node is required" >&2; exit 2; }

# Native OpenCode on Windows (Git Bash) needs Windows-style paths in its config and arguments.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

ROOT="$(native "$(cd "$(dirname "$0")/.." && pwd)")"
SANDBOX="$(mktemp -d)"
PROJECT="$SANDBOX/project"
LOGS="$SANDBOX/logs"
MOCK_PID=""
RUN_PIDS=()
KEEP="${E2E_KEEP:-0}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "${RUN_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  if [ "$KEEP" = "1" ]; then echo "e2e: kept $SANDBOX" >&2; else rm -rf "$SANDBOX"; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

mkdir -p "$LOGS"
cp -R "$ROOT/e2e/project/." "$PROJECT/"
# Never inherit state or config from an earlier local run of the fixture.
rm -rf "$PROJECT/.opencode" "$PROJECT/opencode.jsonc"
# Fixtures that are generated rather than committed: an empty file, a one-line file and a file longer than one read page.
: > "$PROJECT/.ai/empty.md"
printf 'only line\n' > "$PROJECT/.ai/short.md"
node -e 'let t="";for(let i=1;i<=2500;i++)t+="line "+i+"\n";process.stdout.write(t)' > "$PROJECT/.ai/long.md"

# A free port: a fixed one collides with whatever else is running on the machine.
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
export PORT

cat > "$PROJECT/opencode.jsonc" <<JSON
{
  "model": "mock/scripted",
  "plugins": ["$ROOT"],
  "providers": {
    "mock": {
      "name": "Scripted mock",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$PORT/v1", "apiKey": "x" },
      "models": { "scripted": { "modelID": "scripted", "capabilities": { "tools": true, "input": ["text"], "output": ["text"] }, "limit": { "context": 1000000, "output": 4096 } } }
    }
  }
}
JSON

node "$ROOT/e2e/mock-llm.mjs" > "$LOGS/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  grep -q "mock llm on" "$LOGS/mock.log" 2>/dev/null && break
  kill -0 "$MOCK_PID" 2>/dev/null || { echo "e2e: mock LLM failed to start" >&2; cat "$LOGS/mock.log" >&2; exit 1; }
  sleep 0.2
done
grep -q "mock llm on" "$LOGS/mock.log" || { echo "e2e: mock LLM did not start in time" >&2; exit 1; }

# Each session gets its own OpenCode state, so only the plugin's data directory is shared between them.
SESSIONS=(A B C D E F)
run_session() {
  local name="$1" state="$SANDBOX/state-$1"
  mkdir -p "$state"
  (
    cd "$PROJECT"
    export XDG_DATA_HOME="$state/data" XDG_CONFIG_HOME="$state/config" XDG_STATE_HOME="$state/state" XDG_CACHE_HOME="$state/cache"
    if command -v timeout >/dev/null 2>&1; then T="timeout 240"; else T=""; fi
    $T "$OC" run --standalone --auto --title "$name" "SCENARIO-$name read the context" > "$LOGS/session-$name.log" 2>&1
  )
}
for name in "${SESSIONS[@]}"; do
  run_session "$name" &
  RUN_PIDS+=($!)
done

failed=0
for i in "${!SESSIONS[@]}"; do
  if ! wait "${RUN_PIDS[$i]}"; then
    echo "e2e: session ${SESSIONS[$i]} failed (nonzero exit)" >&2
    tail -n 30 "$LOGS/session-${SESSIONS[$i]}.log" >&2 || true
    failed=1
  fi
done
RUN_PIDS=()
[ "$failed" = "0" ] || { echo "e2e: FAILED while running sessions" >&2; exit 1; }

DATA="$PROJECT/.opencode/context-inspector"
echo "--- recorded files ---"
(cd "$DATA" && find . -type f | sort)

echo "--- raw assertions ---"
node "$ROOT/e2e/assert.mjs" "$(native "$DATA")" || { echo "e2e: FAILED raw assertions" >&2; exit 1; }

echo "--- service-level assertions (coverage, analysis) ---"
(cd "$ROOT" && E2E_PROJECT_DIR="$(native "$PROJECT")" npx --no-install vitest run test/e2e-output.test.ts) \
  || { echo "e2e: FAILED service-level assertions" >&2; exit 1; }

echo "e2e: OK"
