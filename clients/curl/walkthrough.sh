#!/usr/bin/env bash
#
# The whole d402 protocol with curl: discover, get a bundle, answer, sign, submit, spend.
#
#   bash clients/curl/walkthrough.sh            # from the repo root (any cwd works)
#
# Needs: bash, curl, python3 (+ the `cryptography` package, used only to sign), node with
# the repo's node_modules (to run the example seller). jq is used when present.
# The only non-curl step is the Ed25519 signature, done with the Python client in
# clients/python (no TypeScript toolchain needed on the agent side).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PY="${PYTHON:-python3}"
export PYTHONPATH="$ROOT/clients/python${PYTHONPATH:+:$PYTHONPATH}"

for tool in curl "$PY" node; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
"$PY" -c 'import cryptography, d402' 2>/dev/null || { echo "python3 needs the cryptography package and clients/python on PYTHONPATH" >&2; exit 1; }

# jq if we have it, else python3
if command -v jq >/dev/null; then
  json() { jq "$@"; }
else
  json() { # supports: json . | json -r .field | json -r '.a.b'
    local raw=0; [ "${1:-}" = "-r" ] && { raw=1; shift; }
    "$PY" -c '
import json, sys
path, raw = sys.argv[1], sys.argv[2] == "1"
v = json.load(sys.stdin)
for part in [p for p in path.strip(".").split(".") if p]:
    v = v[part]
print(v if raw and isinstance(v, str) else json.dumps(v, indent=2))' "${1:-.}" "$raw"
  }
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/d402-curl.XXXXXX")"
PORT="$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
BASE="http://localhost:$PORT"

step() { printf '\n\033[1m## %s\033[0m\n' "$*"; }
show() { printf '$ %s\n' "$*"; }

# --- 0. start the example seller ---------------------------------------------------
step "0. Start the example seller (examples/search-proxy) on port $PORT"
show "PORT=$PORT D402_SECRET=walkthrough node --import tsx examples/search-proxy/src/server.ts &"
( cd "$ROOT" && PORT="$PORT" D402_SECRET=walkthrough NODE_NO_WARNINGS=1 \
    node --import tsx examples/search-proxy/src/server.ts >"$WORK/server.log" 2>&1 ) &
SERVER_PID=$!
cleanup() {
  step "8. Stop the seller"
  show "kill $SERVER_PID"
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$WORK/server.log" >&2; echo "seller exited" >&2; exit 1; }
  sleep 0.2
done
show "curl -s $BASE/health"
curl -s "$BASE/health" | json .

# --- 1. the gate --------------------------------------------------------------------
step "1. Hit the gated route with no voucher: 402 Payment Required with the offer (SPEC 3)"
show "curl -si \"$BASE/search?q=ceasefire\""
curl -s -D "$WORK/h1" -o "$WORK/b1" "$BASE/search?q=ceasefire"
head -1 "$WORK/h1"
json . <"$WORK/b1"
TASK_URL="$(json -r '.accepts[0].taskUrl' <"$WORK/b1" 2>/dev/null || "$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["accepts"][0]["taskUrl"])' "$WORK/b1")"
echo "taskUrl = $TASK_URL"
echo "(the same body is at GET $BASE/.well-known/d402)"

# --- 2. identity --------------------------------------------------------------------
step "2. Make an Ed25519 keypair (D402-Key is the base64url public key)"
show "python3 -c 'from d402 import Keypair; Keypair.generate().save(\"key.json\")'"
"$PY" -c 'from d402 import Keypair; import sys; Keypair.generate().save(sys.argv[1])' "$WORK/key.json"
PUB="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["publicKey"])' "$WORK/key.json")"
echo "D402-Key: $PUB"

# --- 3. bundle ----------------------------------------------------------------------
step "3. Get a bundle (SPEC 4): tier s = 5 items -> 10 calls"
show "curl -s \"$TASK_URL?tier=s\" -H \"D402-Key: \$PUB\" -H \"D402-Model: curl\""
curl -s -D "$WORK/h3" -o "$WORK/bundle.json" "$TASK_URL?tier=s" -H "D402-Key: $PUB" -H "D402-Model: curl"
head -1 "$WORK/h3"
json . <"$WORK/bundle.json"
BUNDLE_ID="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["bundleId"])' "$WORK/bundle.json")"
echo "bundleId = $BUNDLE_ID   (you are not told which items are golden; label all of them)"

# --- 4. answers ---------------------------------------------------------------------
step "4. Answer every item (here: look them up in the demo's answer-key.json; a real agent asks an LLM)"
show "python3 -c '...build {itemId: label} from examples/search-proxy/answer-key.json...' > answers.json"
"$PY" - "$WORK/bundle.json" "$ROOT/examples/search-proxy/answer-key.json" "$WORK/answers.json" <<'PYEOF'
import json, sys
bundle = json.load(open(sys.argv[1])); key = json.load(open(sys.argv[2]))
answers = {item["id"]: key.get(item["id"], bundle["labels"][0]) for item in bundle["items"]}
json.dump(answers, open(sys.argv[3], "w"))
PYEOF
json . <"$WORK/answers.json"

# --- 5. sign + submit ---------------------------------------------------------------
step "5. Sign and submit (SPEC 5): sig = Ed25519(\"d402:submit\\n\" + bundleId + \"\\n\" + canonicalJSON(answers))"
show "python3 -c 'from d402 import sign_submit, canonical_json; ...' > submit.json"
"$PY" - "$WORK/key.json" "$WORK/bundle.json" "$WORK/answers.json" "$WORK/submit.json" <<'PYEOF'
import json, sys
from d402 import sign_submit, submit_message
key = json.load(open(sys.argv[1])); bundle = json.load(open(sys.argv[2])); answers = json.load(open(sys.argv[3]))
msg = submit_message(bundle["bundleId"], answers)
sig = sign_submit(key["privateKey"], bundle["bundleId"], answers)
print("signed message:"); print("  " + msg.replace("\n", "\\n"))
print("sig = " + sig)
json.dump({"answers": answers, "model": "curl", "sig": sig}, open(sys.argv[4], "w"))
PYEOF
show "curl -s -X POST \"$TASK_URL/\$BUNDLE_ID\" -H \"D402-Key: \$PUB\" -H 'Content-Type: application/json' --data @submit.json"
curl -s -D "$WORK/h5" -o "$WORK/voucher.json" -X POST "$TASK_URL/$BUNDLE_ID" \
  -H "D402-Key: $PUB" -H "Content-Type: application/json" --data @"$WORK/submit.json"
head -1 "$WORK/h5"
json . <"$WORK/voucher.json"
if ! grep -q " 200" "$WORK/h5"; then
  echo "submit failed (a 422 quality means not enough goldens were right; get a new bundle and retry)" >&2
  exit 1
fi
VOUCHER="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["voucher"])' "$WORK/voucher.json")"
echo "voucher claims (SPEC 6, HS256 JWT minted by the seller):"
"$PY" -c 'import sys, json; from d402.client import _decode_jwt_payload; print("  " + json.dumps(_decode_jwt_payload(sys.argv[1])))' "$VOUCHER"

# --- 6. spend -----------------------------------------------------------------------
step "6. Spend (SPEC 7): D402-Voucher on the gated route; D402-Calls-Remaining counts down"
for q in ceasefire gpu; do
  show "curl -si \"$BASE/search?q=$q\" -H \"D402-Voucher: \$VOUCHER\""
  curl -s -D "$WORK/h6" -o "$WORK/b6" "$BASE/search?q=$q" -H "D402-Voucher: $VOUCHER"
  head -1 "$WORK/h6"
  grep -i '^d402-calls-remaining' "$WORK/h6" | sed 's/^d402-calls-remaining/D402-Calls-Remaining/I'
  json . <"$WORK/b6"
done

# --- 7. bound spend (optional) -----------------------------------------------------
step "7. Bound spend headers (SPEC 7.1 + 7.2): sig over \"d402:spend\\n\" + METHOD + \"\\n\" + path + \"\\n\" + jti + \"\\n\" + timestamp + \"\\n\" + nonce"
echo "This seller does not set bindVouchers, so it ignores these headers; a seller that does requires them"
echo "(and with requireSpendNonce the D402-Nonce line too; without a nonce the signed string has 5 lines)."
TS="$(date +%s)"
JTI="$("$PY" -c 'import sys; from d402.client import _decode_jwt_payload; print(_decode_jwt_payload(sys.argv[1])["jti"])' "$VOUCHER")"
NONCE="$("$PY" -c 'from d402 import new_nonce; print(new_nonce())')"
SIG="$("$PY" -c 'import json,sys; from d402 import sign_spend, spend_message; print(sign_spend(json.load(open(sys.argv[1]))["privateKey"], "GET", "/search", sys.argv[2], int(sys.argv[3]), sys.argv[4]))' "$WORK/key.json" "$JTI" "$TS" "$NONCE")"
echo "signed message:"
"$PY" -c 'import sys; from d402 import spend_message; print("  " + spend_message("GET", "/search", sys.argv[1], int(sys.argv[2]), sys.argv[3]).replace("\n", "\\n"))' "$JTI" "$TS" "$NONCE"
show "curl -si \"$BASE/search?q=profit\" -H \"D402-Voucher: \$VOUCHER\" -H \"D402-Key: \$PUB\" -H \"D402-Timestamp: $TS\" -H \"D402-Nonce: $NONCE\" -H \"D402-Sig: \$SIG\""
curl -s -D "$WORK/h7" -o "$WORK/b7" "$BASE/search?q=profit" \
  -H "D402-Voucher: $VOUCHER" -H "D402-Key: $PUB" -H "D402-Timestamp: $TS" -H "D402-Nonce: $NONCE" -H "D402-Sig: $SIG"
head -1 "$WORK/h7"
grep -i '^d402-calls-remaining' "$WORK/h7" | sed 's/^d402-calls-remaining/D402-Calls-Remaining/I'
json . <"$WORK/b7"
