#!/usr/bin/env bash
# Exercises POST /run against a running (or self-started) web-yap-runner
# instance and checks the responses against what's expected.
#
# Usage: ./scripts/test.sh [-v|--verbose]
#   -v, --verbose   print the full request/response JSON for every case
set -u

VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
BASE_URL="http://localhost:${PORT}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'

PASS=0
FAIL=0
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

server_up() {
  curl -s -o /dev/null -m 1 "$BASE_URL/run" -X POST -d '{}' -H 'Content-Type: application/json'
}

if server_up; then
  echo "Using already-running server at $BASE_URL"
else
  echo "No server at $BASE_URL — starting one (nix develop --command node src/server.js)..."
  ( cd "$REPO_ROOT" && nix develop --command node src/server.js ) > /tmp/web-yap-runner-test.log 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 30); do
    server_up && break
    sleep 0.5
  done
  if ! server_up; then
    echo "${RED}Server didn't come up in time. Log:${RESET}"
    cat /tmp/web-yap-runner-test.log
    exit 1
  fi
  echo "Server started (pid $SERVER_PID)."
fi
echo

# request <json-body>  ->  sets $STATUS and $BODY
request() {
  local raw
  raw="$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/run" -H 'Content-Type: application/json' -d "$1")"
  STATUS="${raw##*$'\n'}"
  BODY="${raw%$'\n'*}"

  if [ "$VERBOSE" -eq 1 ]; then
    echo "${DIM}--> POST /run${RESET}"
    echo "$1" | jq . | sed 's/^/    /'
    echo "${DIM}<-- ${STATUS}${RESET}"
    echo "$BODY" | jq . | sed 's/^/    /'
  fi
}

# check <name> <jq-boolean-filter>   (evaluated against $BODY)
check() {
  local name="$1" filter="$2"
  if echo "$BODY" | jq -e "$filter" >/dev/null 2>&1; then
    echo "${GREEN}PASS${RESET}  $name"
    PASS=$((PASS + 1))
  else
    echo "${RED}FAIL${RESET}  $name"
    echo "        status=$STATUS body=$BODY"
    FAIL=$((FAIL + 1))
  fi
}

# check_status <name> <expected-http-status>
check_status() {
  local name="$1" expected="$2"
  if [ "$STATUS" = "$expected" ]; then
    echo "${GREEN}PASS${RESET}  $name"
    PASS=$((PASS + 1))
  else
    echo "${RED}FAIL${RESET}  $name (expected $expected, got $STATUS)"
    echo "        body=$BODY"
    FAIL=$((FAIL + 1))
  fi
}

echo "${BOLD}1) Hello world${RESET}"
request '{
  "files": [{"name": "main.yp", "content": "import io\n\ni32 fn main() {\n    io->print:(c\"Hello, world!\");\n    ret 0;\n}\n"}]
}'
check "compiles and runs"        '.was_ok == true'
check "stdout is exactly right"  '.output == "Hello, world!"'
echo

echo "${BOLD}2) Stdin is piped through${RESET}"
request '{
  "files": [{"name": "main.yp", "content": "import io\n\ni32 fn main() {\n    i32 c = io->getchar();\n    while (c != -1) {\n        io->putchar(c);\n        c = io->getchar();\n    }\n    ret 0;\n}\n"}],
  "input": "hello from stdin"
}'
check "runs ok"          '.was_ok == true'
check "echoes stdin back" '.output == "hello from stdin"'
echo

echo "${BOLD}3) Multi-file program (local import)${RESET}"
request '{
  "files": [
    {"name": "main.yp", "content": "import io\nimport \"./helper.yp\"\n\ni32 fn main() {\n    io->print:(c\"sum via helper: \");\n    ret 0;\n}\n"},
    {"name": "helper.yp", "content": "fn helper(){}\n"}
  ]
}'
check "resolves the local import and runs" '.was_ok == true'
echo

echo "${BOLD}4) Compile error is reported cleanly${RESET}"
request '{
  "files": [{"name": "main.yp", "content": "import io\n\ni32 fn main() {\n    io->print:(c\"Hello\"\n    ret 0;\n}\n"}]
}'
check "reports failure"            '.was_ok == false'
check "error message is useful"    '.errors[0] | contains("Syntax error")'
echo

echo "${BOLD}5) A crashing program is caught${RESET}"
request '{
  "files": [{"name": "main.yp", "content": "import io\ni32 fn boom(i32 x) { ret boom(x + 1); }\ni32 fn main() { ret boom(0); }\n"}]
}'
check "reports failure"       '.was_ok == false'
check "identifies the signal" '.errors[0] | contains("SIGSEGV")'
echo

echo "${BOLD}6) An infinite loop is killed (this one takes a few seconds)${RESET}"
request '{
  "files": [{"name": "main.yp", "content": "import io\ni32 fn main() { while(1) {} ret 0; }\n"}]
}'
check "reports failure"    '.was_ok == false'
check "was actually killed" '.errors[0] | test("SIGKILL|timed out")'
echo

echo "${BOLD}7) Disallowed compiler flags are rejected${RESET}"
request '{
  "files": [{"name": "main.yp", "content": "import io\ni32 fn main(){ret 0;}"}],
  "flags": ["-o/etc/passwd"]
}'
check_status "HTTP 400"        400
check "explains why"           '.errors[0] | contains("Flag not allowed")'
echo

echo "${BOLD}8) Path traversal in a file name is rejected${RESET}"
request '{
  "files": [{"name": "../evil.yp", "content": "x"}]
}'
check_status "HTTP 400"        400
check "explains why"           '.errors[0] | contains("escape")'
echo

echo "${BOLD}=== ${GREEN}${PASS} passed${RESET}, $([ "$FAIL" -gt 0 ] && echo "${RED}" || echo "${GREEN}")${FAIL} failed${RESET} ===${RESET}"
[ "$FAIL" -eq 0 ]
