#!/usr/bin/env bash
# Runs against a throwaway session tree. Never touches ~/.claude/projects.
set -uo pipefail

BIN="${BIN:-node dist/cli.js}"
ROOT=/tmp/supercompact-check
PROJ="$ROOT/proj"
SESSIONS="$ROOT/projects/-tmp-supercompact-check-proj"
ID="070e7a0c-1111-2222-3333-444455556666"
FAILED=0

ok()   { printf "  ok    %s\n" "$1"; }
bad()  { printf "  FAIL  %s\n" "$1"; FAILED=1; }
check(){ if [ "$2" = "0" ]; then ok "$1"; else bad "$1"; fi }

setup() {
  rm -rf "$ROOT"
  mkdir -p "$PROJ" "$SESSIONS"
  cat > "$SESSIONS/$ID.jsonl" <<EOF
{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"$ID","cwd":"$PROJ","timestamp":"2026-08-05T00:00:00.000Z","message":{"role":"user","content":"Please build the project"}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"$ID","cwd":"$PROJ","requestId":"req_1","message":{"id":"msg_1","role":"assistant","model":"claude-opus-5","stop_reason":"tool_use","usage":{"input_tokens":90000,"output_tokens":5},"content":[{"type":"text","text":"Building now."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"go build ./...","description":"Build it"}}]}}
{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"$ID","cwd":"$PROJ","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"SECRETOUTPUT compiled 47 files"}]}}
{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"$ID","cwd":"$PROJ","message":{"id":"msg_2","role":"assistant","model":"claude-opus-5","stop_reason":"end_turn","usage":{"input_tokens":95000,"output_tokens":9},"content":[{"type":"text","text":"Build succeeded."}]}}
{"type":"user","uuid":"u3","parentUuid":"a2","sessionId":"$ID","cwd":"$PROJ","message":{"role":"user","content":[{"type":"text","text":"Now check the screenshot"},{"type":"image","source":{"type":"base64","data":"AAAA"}}]}}
{"type":"assistant","uuid":"a3","parentUuid":"u3","sessionId":"$ID","cwd":"$PROJ","message":{"id":"msg_3","role":"assistant","stop_reason":"tool_use","usage":{"input_tokens":99000,"output_tokens":4},"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/tmp/x"}}]}}
{"type":"user","uuid":"u4","parentUuid":"a3","sessionId":"$ID","cwd":"$PROJ","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"SECONDOUTPUT"}]}}
{"type":"assistant","uuid":"a4","parentUuid":"u4","sessionId":"$ID","cwd":"$PROJ","message":{"id":"msg_4","role":"assistant","stop_reason":"end_turn","usage":{"input_tokens":99500,"output_tokens":3},"content":[{"type":"text","text":"All done."}]}}
{"type":"file-history-snapshot","uuid":"f1","parentUuid":null,"sessionId":"$ID","snapshot":{}}
EOF
}

copy_of() { ls -t "$SESSIONS"/*.jsonl | grep -v "$ID" | head -1; }

pairs_ok() {
  python3 - "$1" <<'PY'
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ids={r.get('uuid') for r in rows if r.get('uuid')}
for r in rows:
    p=r.get('parentUuid')
    if p and p not in ids: sys.exit("orphan: "+str(p))
for i,r in enumerate(rows):
    c=(r.get('message') or {}).get('content')
    if r.get('type')!='assistant' or not isinstance(c,list): continue
    calls=[b['id'] for b in c if b.get('type')=='tool_use']
    if not calls: continue
    nxt=rows[i+1] if i+1<len(rows) else {}
    nc=(nxt.get('message') or {}).get('content')
    got=[b.get('tool_use_id') for b in nc if isinstance(b,dict) and b.get('type')=='tool_result'] if isinstance(nc,list) else []
    missing=[c for c in calls if c not in got]
    if missing: sys.exit("unanswered tool_use: "+str(missing))
PY
}

export SUPERCOMPACT_ROOT="$ROOT/projects"
echo "supercompact checks"

setup
SUM=$(shasum "$SESSIONS/$ID.jsonl" | awk '{print $1}')

$BIN version | grep -qE '^supercompact [0-9]+\.[0-9]+\.[0-9]+$'
check "version prints a version" $?

OUT=$($BIN help 2>&1)
echo "$OUT" | grep -q 'keep the conversation'
check "help says what it does" $?

# --- copying ---
$BIN 070e7a0c > /dev/null
check "it copies a session by handle" $?

grep -q 'Please build the project' "$(copy_of)"
check "your words survive" $?

grep -q 'Build succeeded' "$(copy_of)"
check "Claude's words survive" $?

grep -q 'SECRETOUTPUT' "$(copy_of)" && bad "tool output leaked into the copy" || ok "tool output is dropped"

grep -q 'Now check the screenshot' "$(copy_of)"
check "a prompt with an image keeps its text" $?

grep -q '"data":"AAAA"' "$(copy_of)" && bad "the image itself came along" || ok "the image itself is dropped"

pairs_ok "$(copy_of)"
check "the copy has no orphans and no unanswered calls" $?

grep -q 'usageIsEstimate' "$(copy_of)"
check "the copy carries its new size" $?

[ "$SUM" = "$(shasum "$SESSIONS/$ID.jsonl" | awk '{print $1}')" ]
check "the original is byte for byte unchanged" $?

# --- tool lines ---
setup
$BIN 070e7a0c --tools > /dev/null
grep -q 'You used tool Bash(command: go build' "$(copy_of)"
check "--tools writes the call out as a line" $?
grep -q 'SECRETOUTPUT' "$(copy_of)" && bad "--tools leaked output" || ok "--tools still drops the output"

# --- keeping ---
setup
$BIN 070e7a0c --keep-tools 1 > /dev/null
grep -q 'SECONDOUTPUT' "$(copy_of)"
check "--keep-tools keeps the newest result whole" $?
grep -q 'SECRETOUTPUT' "$(copy_of)" && bad "--keep-tools 1 kept two results" || ok "--keep-tools 1 keeps exactly one"
pairs_ok "$(copy_of)"
check "a kept call still has its answer" $?

setup
$BIN 070e7a0c --keep-last 4 > /dev/null
grep -q '"data":"AAAA"' "$(copy_of)"
check "--keep-last brings the image back" $?
pairs_ok "$(copy_of)"
check "--keep-last leaves the chain intact" $?

setup
$BIN 070e7a0c --tools --keep-tools 1 > /dev/null
pairs_ok "$(copy_of)"
check "tool lines never split a call from its answer" $?

# --- preview ---
setup
BEFORE=$(ls "$SESSIONS" | wc -l)
OUT=$($BIN 070e7a0c --preview 2>&1)
echo "$OUT" | grep -q 'Nothing was written'
check "preview says it wrote nothing" $?
[ "$BEFORE" = "$(ls "$SESSIONS" | wc -l)" ]
check "preview really wrote nothing" $?
OUT=$($BIN 070e7a0c --preview --json 2>&1)
echo "$OUT" | grep -q '"costs"'
check "preview returns a price for every option" $?
OUT=$($BIN 070e7a0c --preview 2>&1)
echo "$OUT" | grep -q 'as the API reported it'
check "preview uses the reported size when there is one" $?

# --- in place ---
setup
$BIN 070e7a0c --in-place > /dev/null
grep -q 'Please build the project' "$SESSIONS/$ID.jsonl"
check "in place keeps the same file and your words" $?
grep -q 'SECRETOUTPUT' "$SESSIONS/$ID.jsonl" && bad "in place kept old tool output" || ok "in place drops the old output"
grep -q 'SECONDOUTPUT' "$SESSIONS/$ID.jsonl"
check "in place leaves the turn in progress alone" $?
pairs_ok "$SESSIONS/$ID.jsonl"
check "in place leaves no orphans" $?
grep -q '"input_tokens":99500' "$SESSIONS/$ID.jsonl" && bad "the old size is still being reported" || ok "the old size is gone"
grep -q 'usageIsEstimate' "$SESSIONS/$ID.jsonl"
check "in place writes the new size" $?
grep -q '(SC1)' "$SESSIONS/sessions-index.json"
check "the session is marked as compacted" $?
grep -q 'SECRETOUTPUT' "$(copy_of)"
check "the full copy kept everything" $?

# --- measure ---
setup
OUT=$($BIN measure 2>&1)
echo "$OUT" | grep -q 'tool calls and results'
check "measure reports a number" $?

echo "$OUT" | grep -q 'the floor rather than the best case'
check "measure says what it is leaving out" $?
OUT=$($BIN measure --json 2>&1)
echo "$OUT" | grep -q '"reclaimableTokens"'
check "measure --json reports what could be given back" $?

echo "$OUT" | grep -q '"heldBackIs"'
check "measure --json names what it held back" $?

# --- typos do not pass quietly ---
setup
OUT=$($BIN 070e7a0c --keep-tool 5 2>&1)
echo "$OUT" | grep -q 'no such option'
check "a misspelled option stops instead of doing nothing" $?

OUT=$($BIN 070e7a0c --keep-last abc 2>&1)
echo "$OUT" | grep -q 'wants a whole number'
check "a keep count that is not a number stops" $?

OUT=$($BIN 070e7a0c --keep-last 2 2>&1)
echo "$OUT" | grep -q 'kept'
check "a real option still runs" $?

# --- the bare command ---
setup
OUT=$($BIN --project-dir "$PROJ" 2>&1)
echo "$OUT" | grep -q 'kept'
check "with no session named it acts on the one in this directory" $?

# --- twice over ---
setup
$BIN 070e7a0c --in-place > /dev/null
$BIN 070e7a0c --in-place > /dev/null
grep -q '(SC2)' "$SESSIONS/sessions-index.json"
check "compacting twice counts the generations" $?

# --- failure paths ---
OUT=$($BIN zzzzzzzz 2>&1)
echo "$OUT" | grep -q 'no session matching'
check "an unknown id fails clearly" $?

echo
if [ "$FAILED" = "0" ]; then echo "all supercompact checks passed"; else echo "supercompact checks FAILED"; exit 1; fi
