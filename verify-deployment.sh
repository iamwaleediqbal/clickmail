#!/usr/bin/env bash
#
# Prove the deployed site cannot spend anything.
#
# The design is that production has no OpenRouter key, so no request to it can
# reach a provider. That is a claim about a Vercel environment variable, which
# is not visible from this repository — so it is checked from outside, against
# the running site, the way anyone else would probe it.
#
#   ./verify-deployment.sh https://clickgym.vercel.app
#
# It only reads. Nothing here signs in, and nothing here starts a run: every
# request it makes is one it expects to be refused.
#
# Written for bash 3.2, which is what macOS ships.

set -eu

BASE="${1:-}"
[ -n "$BASE" ] || { printf 'usage: %s https://your-deployment\n' "$0" >&2; exit 2; }
BASE="${BASE%/}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED="yes"; }
bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

FAILED=""

status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"
}

body() {
  curl -s --max-time 20 "$@"
}

bold "Checking $BASE"

# --- the site is actually up ------------------------------------------------

CODE="$(status "$BASE/")"
case "$CODE" in
  200) ok "the console is serving (200)" ;;
  *)   bad "the console answered $CODE — is the URL right?"; printf '\n'; exit 1 ;;
esac

# --- the posture the deployment reports about itself ------------------------

SESSION="$(body "$BASE/api/session")"
printf '  %s\n' "$SESSION"

# Matched with a pattern that tolerates whitespace rather than with a glob on
# `"runs":false`. Written as a glob, this missed `"runs": false` — and the
# *enabled* check then fell through to its ok branch and reported owner mode as
# off on a deployment that had it on. A green tick for a fact nobody checked.
json_says() {
  printf '%s' "$SESSION" | grep -Eq "\"$1\"[[:space:]]*:[[:space:]]*$2"
}

if json_says runs false; then
  ok "it reports that it cannot run models"
elif json_says runs true; then
  bad "it reports that runs ARE enabled — a model key is set on this deployment"
else
  bad "it did not report a posture at all (an older build?)"
fi

if json_says enabled true; then
  bad "owner mode is configured in production — the sign-in leads nowhere without a key"
elif json_says enabled false; then
  ok "owner mode is off, so the sign-in control hides itself"
else
  bad "it did not say whether owner mode is configured"
fi

# --- the thing that would cost money ----------------------------------------
#
# A run request as a stranger would send it. 503 is the deployment saying it has
# no key; 403 would mean a key is present and it is the permission check turning
# us away. Anything in the 2xx range means it tried.

bold "Trying to start a run, the way anyone could"

PAYLOAD='{"model":"openrouter/free","mode":"tool","messages":[{"role":"user","content":"hello"}]}'

CODE="$(status -X POST "$BASE/api/agent" -H 'Content-Type: application/json' -d "$PAYLOAD")"
case "$CODE" in
  503) ok "refused as unavailable (503) — there is no key to spend" ;;
  403) bad "refused as forbidden (403) — a key IS configured here; the gate is all that stands between a visitor and it" ;;
  2*)  bad "IT RAN (${CODE}). Remove OPENROUTER_API_KEY from the deployment now." ;;
  *)   bad "unexpected answer $CODE" ;;
esac

# The cookie the first version of this gate used. Anyone reading the repository
# would try it, so it is tried here.
CODE="$(status -X POST "$BASE/api/agent" -H 'Content-Type: application/json' \
  -H 'Cookie: cg_owner=1' -d "$PAYLOAD")"
case "$CODE" in
  503|403) ok "a forged cg_owner=1 cookie changes nothing ($CODE)" ;;
  2*)      bad "THE FORGED COOKIE WORKED (${CODE}). Deploy the current code immediately." ;;
  *)       bad "unexpected answer $CODE to the forged cookie" ;;
esac

# --- what a visitor can still reach -----------------------------------------

bold "What a visitor can reach"

CODE="$(status "$BASE/runs/index.json")"
case "$CODE" in
  200) ok "the committed runs file is served — that is the evidence, and only a push changes it" ;;
  404) ok "no runs published yet (the console falls back to its samples)" ;;
  *)   bad "the runs file answered $CODE" ;;
esac

CODE="$(status "$BASE/gym")"
case "$CODE" in
  200) ok "the environment is browsable, which costs nothing" ;;
  *)   bad "/gym answered $CODE" ;;
esac

# --- verdict ----------------------------------------------------------------

if [ -n "$FAILED" ]; then
  printf '\n\033[31m✗ This deployment is not in the read-only posture.\033[0m\n'
  printf '  Vercel → Project → Settings → Environment Variables.\n'
  printf '  Production should have neither OPENROUTER_API_KEY nor OWNER_PASSCODE.\n\n'
  exit 1
fi

printf '\n\033[32m✓ Read-only. No request to this deployment can reach a model provider.\033[0m\n'
printf '  Record runs locally instead:  ./record-runs.sh\n'
printf '  Then publish them by pushing: git add public/runs && git commit && git push\n\n'
