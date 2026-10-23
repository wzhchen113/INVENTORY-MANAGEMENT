#!/usr/bin/env bash
# scripts/smoke-send-email-hook.sh — Spec 166 smoke for the GoTrue Send Email
# hook (`supabase/functions/auth-email-hook`): GoTrue hands every auth mail to
# the function, which DROPS spec 165 placeholder recipients and delivers every
# other mail (locally into Mailpit).
#
# Sibling of scripts/smoke-store-user.sh: same pass/fail/skip output, same
# accumulator contract (every arm runs; `exit $FAILED` at the end), same
# local-only refusal, same EXIT-trap cleanup.
#
# Arms (spec 166 §11):
#    P   preflight: hook enabled in GoTrue, secrets match, Mailpit up, fn served
#    S5  signature gate: unsigned / wrong / stale → 401, GET → 405, malformed → 400,
#        oversize → 413, and nothing reaches Mailpit
#    S1  /recover to a placeholder → 200, Mailpit total 0, hook logged "dropped"
#    S2  /recover to manager@local.test → 200, exactly 1 message, spec 085 link
#    S3  the S2 token_hash redeems via POST /verify → access_token
#    S3b PKCE-shaped /recover (like the app) → its token_hash redeems too
#    S4  anti-enumeration: placeholder / real / unknown → identical status + body
#    S6  signed synthetic payloads: every action type (real → 1 message with the
#        §3.3 subject; placeholder → 0), the email_change swap, mixed legs
#    S10 (spec 168) signed synthetic payload to a real recipient the transport
#        (Mailpit) rejects → 500 {"error":"delivery failed"}, Mailpit total 0,
#        hook logged outcome:failed reason:transport status:<Mailpit's code>
#    S6b real GoTrue invite → the /verify link redeems (records the D11 branch)
#    S9  real secure email change → both legs' hashes match GoTrue's stored tokens
#        and each leg redeems on its own (two rounds), auth.users.email updated.
#        Spec 168: the redemption half needs GOTRUE_MAILER_AUTOCONFIRM=true and
#        SKIPs otherwise; the hash-equality half always runs
#    S7  hygiene: no token / hash / placeholder in hook bodies or edge logs;
#        hook log lines carry only the §5 key set
#    S8  SKIP — prod (Resend) transport is proven in jest (spec 166 D10)
#
# Usage:
#   bash scripts/smoke-send-email-hook.sh   # local stack only (refuses remote)
#
# TEST-ONLY knob (spec 168): S9_AUTOCONFIRM_OVERRIDE=<value> replaces the
# GOTRUE_MAILER_AUTOCONFIRM value read from the auth container, so any value
# other than `true` forces the S9 redemption SKIP branch. It only reduces
# coverage, its use is printed in S9's output, and it is never set in
# `npm run test:smoke`.
#
# NOTE: this smoke WIPES the local Mailpit inbox (DELETE /api/v1/messages).
#
# Fixtures (all removed by the EXIT trap): every auth user whose email or
# profile username starts with zz_s166 (one placeholder store user created via
# manage-store-user, one real-email user, one invited user), plus any
# audit_log rows whose item_ref starts with zz_s166. If interrupted with
# kill -9, recover with:
#   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
#     "delete from public.audit_log where item_ref like 'zz_s166%';
#      delete from auth.users where id in (select id from public.profiles where username like 'zz_s166%')
#         or email like 'zz_s166%';"
#
# Rate limits: arms that hit /recover for the same user are spaced by 2 s
# (local max_frequency = 1s). The run makes ~5 /verify calls against
# token_verifications = 30 per 5 min per IP; back-to-back reruns inside
# 5 minutes can still hit a 429.
#
# Exit code: non-zero on failure.

set -u

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    printf '\033[31mREFUSE\033[0m smoke-send-email-hook.sh mutates state and only runs against a local stack.\n' >&2
    printf '       SUPABASE_URL=%s is non-local. Aborting.\n' "$SUPABASE_URL" >&2
    exit 2
    ;;
esac

DB_CONTAINER="supabase_db_imr-inventory"
EDGE_CONTAINER="supabase_edge_runtime_imr-inventory"
AUTH_CONTAINER="supabase_auth_imr-inventory"
MAILPIT_URL="${MAILPIT_URL:-http://127.0.0.1:54324}"
HOOK_URL="${SUPABASE_URL}/functions/v1/auth-email-hook"
BRAND_A="2a000000-0000-0000-0000-000000000001"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password}"
REAL_EMAIL="${REAL_EMAIL:-manager@local.test}"
RECOVERY_REDIRECT="http://localhost:8081/reset-password"

FAILED=0
BODIES_FILE="$(mktemp -t smoke-send-email-hook.bodies.XXXXXX)"
SECRETS_FILE="$(mktemp -t smoke-send-email-hook.secrets.XXXXXX)"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s (reason: %s)\n' "$1" "$2"; }
step() { printf '\n== %s ==\n' "$1"; }

psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -Atc "$1" 2>/dev/null; }

cleanup() {
  local exit_code=$?
  printf '\n== cleanup ==\n'
  psql_q "delete from public.audit_log where item_ref like 'zz_s166%';
          delete from auth.users where id in (select id from public.profiles where username like 'zz_s166%') or email like 'zz_s166%';" >/dev/null \
    && pass "removed zz_s166 users" \
    || printf '  \033[31mWARN\033[0m cleanup failed — see header for manual recovery\n'
  rm -f "$BODIES_FILE" "$SECRETS_FILE"
  exit "$exit_code"
}
trap cleanup EXIT

remember() { local v; for v in "$@"; do [[ -n "$v" ]] && printf '%s\n' "$v" >> "$SECRETS_FILE"; done; }

# ── Mailpit helpers ─────────────────────────────────────────────────────────
mp_total() { curl -sS "${MAILPIT_URL}/api/v1/messages?limit=1" 2>/dev/null | jq -r '.total // -1'; }
mp_clear() { curl -sS -o /dev/null -X DELETE "${MAILPIT_URL}/api/v1/messages"; }
# mp_wait <n> [secs] — poll every 250 ms until total = n; "= 0" is a fixed 2 s settle.
mp_wait() {
  local want="$1" secs="${2:-6}" i got
  if [[ "$want" == "0" ]]; then sleep 2; [[ "$(mp_total)" == "0" ]]; return; fi
  for ((i = 0; i < secs * 4; i++)); do
    got=$(mp_total)
    [[ "$got" == "$want" ]] && { sleep 0.3; [[ "$(mp_total)" == "$want" ]]; return; }
    sleep 0.25
  done
  return 1
}
# mp_msg <to> — prints the full message JSON (To/Subject/Text/HTML) of the
# newest message addressed to <to>, or nothing.
mp_msg() {
  local id
  id=$(curl -sS -G "${MAILPIT_URL}/api/v1/search" --data-urlencode "query=to:\"$1\"" | jq -r '.messages[0].ID // empty')
  [[ -n "$id" ]] && curl -sS "${MAILPIT_URL}/api/v1/message/${id}"
}
mp_count_to() {
  curl -sS -G "${MAILPIT_URL}/api/v1/search" --data-urlencode "query=to:\"$1\"" | jq -r '.messages_count // 0'
}

# ── Standard Webhooks signing ───────────────────────────────────────────────
# sign_headers <body> [key_hex] [timestamp] → sets SIG_ID, SIG_TS, SIG
sign_headers() {
  local body="$1" key="${2:-$HOOK_KEY_HEX}" ts="${3:-$(date +%s)}"
  SIG_ID="msg_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  SIG_TS="$ts"
  SIG=$(printf '%s' "${SIG_ID}.${SIG_TS}.${body}" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${key}" -binary | openssl base64 -A)
}
# hook_signed <body> [key_hex] [timestamp] → sets CODE, BODY
hook_signed() {
  local out
  sign_headers "$@"
  out=$(curl -sS -w '\n%{http_code}' -X POST "$HOOK_URL" -H "Content-Type: application/json" \
    -H "webhook-id: ${SIG_ID}" -H "webhook-timestamp: ${SIG_TS}" -H "webhook-signature: v1,${SIG}" \
    --data-binary "$1")
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
  printf '%s\n' "$BODY" >> "$BODIES_FILE"
}
# hook_raw <method> <body> [extra curl args...] → sets CODE, BODY (unsigned)
hook_raw() {
  local method="$1" body="$2" out
  shift 2
  out=$(curl -sS -w '\n%{http_code}' -X "$method" "$HOOK_URL" -H "Content-Type: application/json" "$@" --data-binary "$body")
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
  printf '%s\n' "$BODY" >> "$BODIES_FILE"
}

# recover <email> [json extras] [query] → sets CODE, BODY
recover() {
  local email="$1" extra="${2:-}" query="${3:-}" out
  [[ -z "$extra" ]] && extra='{}'
  out=$(curl -sS -w '\n%{http_code}' -X POST "${SUPABASE_URL}/auth/v1/recover${query}" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$email" --argjson x "$extra" '{email:$e} + $x')")
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# verify_hash <type> <token_hash> → sets CODE, BODY
verify_hash() {
  local out
  out=$(curl -sS -w '\n%{http_code}' -X POST "${SUPABASE_URL}/auth/v1/verify" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg t "$1" --arg h "$2" '{type:$t, token_hash:$h}')")
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

subject_for() {
  case "$1" in
    recovery) echo "Reset your password" ;;
    signup) echo "Confirm your email" ;;
    invite) echo "You have been invited to I.M.R" ;;
    magiclink) echo "Your sign-in link" ;;
    email) echo "Your sign-in code" ;;
    email_change) echo "Confirm your email change" ;;
    reauthentication) echo "Your verification code" ;;
    password_changed_notification) echo "Your password was changed" ;;
    email_changed_notification) echo "Your email address was changed" ;;
    phone_changed_notification) echo "Your phone number was changed" ;;
    identity_linked_notification) echo "A sign-in method was linked to your account" ;;
    identity_unlinked_notification) echo "A sign-in method was removed from your account" ;;
    mfa_factor_enrolled_notification) echo "A verification method was added to your account" ;;
    mfa_factor_unenrolled_notification) echo "A verification method was removed from your account" ;;
    *) echo "Account notification" ;;
  esac
}

# syn_payload <action> <email> <new_email> <token> <token_hash> <token_new> <token_hash_new> [old_email]
syn_payload() {
  jq -cn --arg a "$1" --arg e "$2" --arg ne "$3" --arg t "$4" --arg h "$5" --arg tn "$6" --arg hn "$7" \
    --arg oe "${8:-}" --arg r "$RECOVERY_REDIRECT" --arg s "${SUPABASE_URL}/auth/v1" \
    '{user:{id:"00000000-0000-0000-0000-000000000166", email:$e, new_email:$ne},
      email_data:{token:$t, token_hash:$h, redirect_to:$r, email_action_type:$a, site_url:$s,
                  token_new:$tn, token_hash_new:$hn, old_email:$oe}}'
}

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
rand_code() { printf '%06d' $(( $(od -An -N3 -tu4 /dev/urandom | tr -d ' ') % 1000000 )); }

################################################################################
step "P: preflight"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  skip "all arms" "local stack not running (npm run dev:db)"
  exit 0
fi
ANON_KEY="${SUPABASE_ANON_KEY:-$(docker exec "$EDGE_CONTAINER" printenv SUPABASE_ANON_KEY 2>/dev/null)}"
SERVICE_KEY="$(docker exec "$EDGE_CONTAINER" printenv SUPABASE_SERVICE_ROLE_KEY 2>/dev/null)"
if [[ -z "$ANON_KEY" || -z "$SERVICE_KEY" ]]; then
  fail "could not read SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY from $EDGE_CONTAINER"
  exit 1
fi
pass "read local keys"

RESTART_HINT="restart from clean: npx supabase stop --no-backup && npm run dev:db"
HOOK_ENABLED=$(docker exec "$AUTH_CONTAINER" printenv GOTRUE_HOOK_SEND_EMAIL_ENABLED 2>/dev/null)
if [[ "$HOOK_ENABLED" != "true" ]]; then
  fail "GoTrue GOTRUE_HOOK_SEND_EMAIL_ENABLED='${HOOK_ENABLED}' (expected true) — ${RESTART_HINT}"
  exit 1
fi
pass "GoTrue Send Email hook enabled"

GOTRUE_SECRET=$(docker exec "$AUTH_CONTAINER" printenv GOTRUE_HOOK_SEND_EMAIL_SECRETS 2>/dev/null)
EDGE_SECRET=$(docker exec "$EDGE_CONTAINER" printenv SEND_EMAIL_HOOK_SECRET 2>/dev/null)
if [[ -z "$EDGE_SECRET" || "$GOTRUE_SECRET" != "$EDGE_SECRET" ]]; then
  fail "GoTrue hook secret and edge-runtime SEND_EMAIL_HOOK_SECRET differ or are unset — ${RESTART_HINT}"
  exit 1
fi
case "$EDGE_SECRET" in
  *'|'*) fail "local hook secret has rotation parts; the smoke signs with a single secret"; exit 1 ;;
esac
HOOK_KEY_HEX=$(printf '%s' "${EDGE_SECRET#v1,whsec_}" | openssl base64 -d -A | od -An -v -tx1 | tr -d ' \n')
if [[ -z "$HOOK_KEY_HEX" ]]; then
  fail "could not decode the local hook secret"
  exit 1
fi
pass "GoTrue and edge-runtime hook secrets match (local dev literal)"

if ! curl -sS -o /dev/null --max-time 5 "${MAILPIT_URL}/api/v1/info" 2>/dev/null; then
  fail "Mailpit API not reachable at ${MAILPIT_URL} — the hook delivers through it"
  exit 1
fi
pass "Mailpit API reachable"

SMOKE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
hook_raw POST '{}'
if [[ "$CODE" == "401" && "$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)" == '{"error":"invalid signature"}' ]]; then
  pass "unsigned POST → 401 invalid signature (function served, gateway JWT off)"
else
  fail "unsigned POST → HTTP $CODE body=$BODY (404/503: check the CLAUDE.md edge bind-mount note)"
  exit 1
fi

################################################################################
step "Setup: fixtures"
mp_clear
[[ "$(mp_total)" == "0" ]] && pass "Mailpit cleared" || fail "Mailpit not empty after clear"

SFX=$(rand_hex 3)
ADMIN_BEARER=$(curl -sS -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" | jq -r '.access_token // empty')
STORE_A1=$(psql_q "select id from public.stores where brand_id='${BRAND_A}' order by name limit 1")
PH_USER="zz_s166_p${SFX}"
PH_EMAIL=""
if [[ -n "$ADMIN_BEARER" && -n "$STORE_A1" ]]; then
  CREATE_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${SUPABASE_URL}/functions/v1/manage-store-user" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${ADMIN_BEARER}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg u "$PH_USER" --arg s "$STORE_A1" --arg p "S166-pw-$(rand_hex 4)" \
      '{action:"create", name:"Smoke 166 Placeholder", username:$u, password:$p, storeIds:[$s]}')")
  PH_EMAIL=$(psql_q "select u.email from auth.users u join public.profiles p on p.id = u.id where p.username = '${PH_USER}'")
  [[ "$CREATE_CODE" == "201" && -n "$PH_EMAIL" ]] \
    && pass "placeholder fixture ${PH_USER} via manage-store-user" \
    || fail "placeholder fixture via manage-store-user → HTTP ${CREATE_CODE}"
else
  fail "could not sign in ${ADMIN_EMAIL} or find a brand A store for the placeholder fixture"
fi
remember "$PH_EMAIL"

REAL_FX="zz_s166_r${SFX}@local.test"
REAL_FX_PW="S166-real-$(rand_hex 4)"
FX_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
  -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg e "$REAL_FX" --arg p "$REAL_FX_PW" '{email:$e, password:$p, email_confirm:true}')")
[[ "$FX_CODE" == "200" ]] && pass "real-email fixture ${REAL_FX}" || fail "real-email fixture → HTTP ${FX_CODE}"
remember "$REAL_FX" "$REAL_EMAIL"
[[ "$(mp_total)" == "0" ]] && pass "fixture creation sent no mail" || fail "fixture creation sent mail"

################################################################################
step "S5: signature gate (nothing may reach Mailpit)"
hook_raw POST "$(syn_payload recovery "$REAL_EMAIL" "" 1 h "" "")"
[[ "$CODE" == "401" ]] && pass "no signature headers → 401" || fail "no signature headers → HTTP $CODE"

WRONG_KEY=$(rand_hex 32)
hook_signed "$(syn_payload recovery "$REAL_EMAIL" "" 1 h "" "")" "$WRONG_KEY"
[[ "$CODE" == "401" && "$(printf '%s' "$BODY" | jq -r '.error // empty')" == "invalid signature" ]] \
  && pass "wrong signature → 401" || fail "wrong signature → HTTP $CODE body=$BODY"

hook_signed "$(syn_payload recovery "$REAL_EMAIL" "" 1 h "" "")" "$HOOK_KEY_HEX" "$(( $(date +%s) - 600 ))"
[[ "$CODE" == "401" ]] && pass "valid signature, timestamp now-600s → 401" || fail "stale timestamp → HTTP $CODE"

GET_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X GET "$HOOK_URL")
[[ "$GET_CODE" == "405" ]] && pass "GET → 405" || fail "GET → HTTP $GET_CODE"

hook_signed '{}'
[[ "$CODE" == "400" && "$(printf '%s' "$BODY" | jq -r '.error // empty')" == "invalid payload" ]] \
  && pass "signed {} → 400 invalid payload" || fail "signed {} → HTTP $CODE body=$BODY"

hook_signed '{"user":{},"email_data":{}}'
[[ "$CODE" == "400" ]] && pass 'signed {"user":{},"email_data":{}} → 400' || fail "signed empty user/email_data → HTTP $CODE"

BIG=$(head -c 70000 /dev/zero | tr '\0' 'a')
hook_raw POST "{\"pad\":\"${BIG}\"}"
[[ "$CODE" == "413" ]] && pass "70 KB body → 413 (size guard before HMAC)" || fail "oversize body → HTTP $CODE"

mp_wait 0 && pass "Mailpit total still 0 after S5" || fail "S5 leaked mail: total=$(mp_total)"

################################################################################
step "S1: /recover to a placeholder → 200, 0 messages"
if [[ -n "$PH_EMAIL" ]]; then
  recover "$PH_EMAIL"
  S1_CODE="$CODE"; S1_BODY="$BODY"
  [[ "$CODE" == "200" ]] && pass "/recover placeholder → 200" || fail "/recover placeholder → HTTP $CODE body=$BODY"
  if mp_wait 0; then pass "Mailpit total = 0 (placeholder mail dropped)"; else fail "Mailpit total = $(mp_total) after placeholder /recover"; fi
  if docker logs --since "$SMOKE_START" "$EDGE_CONTAINER" 2>&1 | grep -F '"hook":"auth-email-hook"' \
      | grep -F '"action":"recovery"' | grep -qF '"outcome":"dropped"'; then
    pass "hook was invoked and logged outcome:dropped (GoTrue did not just skip the send)"
  else
    fail "no auth-email-hook recovery/dropped log line — the hook may not have been called"
  fi
else
  fail "S1 skipped: no placeholder fixture"
fi

################################################################################
step "S2: /recover to ${REAL_EMAIL} → exactly 1 message with the spec 085 link"
mp_clear
recover "$REAL_EMAIL" '{}' "?redirect_to=$(jq -rn --arg r "$RECOVERY_REDIRECT" '$r|@uri')"
[[ "$CODE" == "200" ]] && pass "/recover ${REAL_EMAIL} → 200" || fail "/recover ${REAL_EMAIL} → HTTP $CODE body=$BODY"
H=""
if mp_wait 1; then
  pass "Mailpit total = 1"
  MSG=$(mp_msg "$REAL_EMAIL")
  TO=$(printf '%s' "$MSG" | jq -r '[.To[].Address] | join(",")')
  SUBJ=$(printf '%s' "$MSG" | jq -r '.Subject')
  TEXT=$(printf '%s' "$MSG" | jq -r '.Text')
  HTML=$(printf '%s' "$MSG" | jq -r '.HTML')
  [[ "$TO" == "$REAL_EMAIL" ]] && pass "To = ${REAL_EMAIL}" || fail "To = '${TO}'"
  [[ "$SUBJ" == "Reset your password" ]] && pass "Subject = Reset your password" || fail "Subject = '${SUBJ}'"
  H=$(printf '%s' "$TEXT" | grep -oE "${RECOVERY_REDIRECT}\?token_hash=[^&[:space:]]+&type=recovery" | head -1 | sed -E 's/.*token_hash=([^&]+)&type=recovery/\1/')
  if [[ -n "$H" ]]; then
    pass "Text has ${RECOVERY_REDIRECT}?token_hash=<hash>&type=recovery"
    remember "$H"
    printf '%s' "$HTML" | grep -qF "${RECOVERY_REDIRECT}?token_hash=${H}&amp;type=recovery" \
      && pass "HTML has the &amp;type=recovery form" || fail "HTML link form missing"
  else
    fail "Text lacks the spec 085 recovery link"
  fi
else
  fail "Mailpit total = $(mp_total) (expected 1)"
fi

################################################################################
step "S3: the rendered token_hash redeems"
if [[ -n "$H" ]]; then
  verify_hash recovery "$H"
  if [[ "$CODE" == "200" && -n "$(printf '%s' "$BODY" | jq -r '.access_token // empty')" ]]; then
    pass "POST /verify {type:recovery, token_hash} → 200 + access_token"
  else
    fail "POST /verify → HTTP $CODE"
  fi
else
  fail "S3 skipped: no hash from S2"
fi

################################################################################
step "S3b: PKCE-shaped /recover (app-faithful) → token_hash redeems"
sleep 2
mp_clear
VERIFIER="$(rand_hex 32)"
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
recover "$REAL_EMAIL" "$(jq -cn --arg c "$CHALLENGE" '{code_challenge:$c, code_challenge_method:"s256"}')" \
  "?redirect_to=$(jq -rn --arg r "$RECOVERY_REDIRECT" '$r|@uri')"
[[ "$CODE" == "200" ]] && pass "PKCE /recover → 200" || fail "PKCE /recover → HTTP $CODE body=$BODY"
H2=""
if mp_wait 1; then
  TEXT=$(mp_msg "$REAL_EMAIL" | jq -r '.Text')
  H2=$(printf '%s' "$TEXT" | grep -oE "token_hash=[^&[:space:]]+&type=recovery" | head -1 | sed -E 's/token_hash=([^&]+)&type=recovery/\1/')
  remember "$H2"
  case "$H2" in pkce_*) S3B_SHAPE="pkce_-prefixed" ;; "") S3B_SHAPE="missing" ;; *) S3B_SHAPE="plain" ;; esac
  pass "1 message; token_hash is ${S3B_SHAPE}"
else
  fail "PKCE /recover: Mailpit total = $(mp_total) (expected 1)"
fi
if [[ -n "$H2" ]]; then
  verify_hash recovery "$H2"
  [[ "$CODE" == "200" && -n "$(printf '%s' "$BODY" | jq -r '.access_token // empty')" ]] \
    && pass "PKCE token_hash redeems via POST /verify → 200 + access_token" \
    || fail "PKCE token_hash /verify → HTTP $CODE (BLOCKING: escalate to the architect, spec 166 §11 S3b)"
else
  fail "S3b: no PKCE token_hash extracted"
fi

################################################################################
step "S4: anti-enumeration — placeholder / real / unknown"
if [[ -n "$PH_EMAIL" ]]; then
  recover "$PH_EMAIL"; C1="$CODE"; B1="$BODY"
  sleep 2
  recover "$REAL_EMAIL"; C2="$CODE"; B2="$BODY"
  recover "zz_s166_nobody${SFX}@local.test"; C3="$CODE"; B3="$BODY"
  if [[ "$C1" == "200" && "$C1" == "$C2" && "$C2" == "$C3" && "$B1" == "$B2" && "$B2" == "$B3" && "$B1" == "${S1_BODY:-$B1}" ]]; then
    pass "identical status (${C1}) and byte-identical body ('${B1}') for all three"
  else
    fail "differs: placeholder=${C1} '${B1}', real=${C2} '${B2}', unknown=${C3} '${B3}'"
  fi
else
  fail "S4 skipped: no placeholder fixture"
fi

################################################################################
step "S6: signed synthetic payloads"
SYN="zz_s166_syn${SFX}@local.test"
remember "$SYN"
for T in signup invite magiclink email reauthentication \
         password_changed_notification email_changed_notification phone_changed_notification \
         identity_linked_notification identity_unlinked_notification \
         mfa_factor_enrolled_notification mfa_factor_unenrolled_notification zz_future_type; do
  mp_clear
  SH="synhash$(rand_hex 12)"; SC=$(rand_code)
  remember "$SH" "$SC"
  hook_signed "$(syn_payload "$T" "$SYN" "" "$SC" "$SH" "" "")"
  if [[ "$CODE" != "200" || "$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)" != "{}" ]]; then
    fail "${T} → HTTP $CODE body=$BODY"; continue
  fi
  if ! mp_wait 1; then fail "${T}: Mailpit total = $(mp_total) (expected 1)"; continue; fi
  MSG=$(mp_msg "$SYN")
  SUBJ=$(printf '%s' "$MSG" | jq -r '.Subject'); TEXT=$(printf '%s' "$MSG" | jq -r '.Text'); HTML=$(printf '%s' "$MSG" | jq -r '.HTML')
  WANT_SUBJ=$(subject_for "$T")
  OK=1; WHY=""
  [[ "$SUBJ" == "$WANT_SUBJ" ]] || { OK=0; WHY="subject '${SUBJ}'"; }
  case "$T" in
    signup|invite|magiclink|email|zz_future_type)
      printf '%s' "$TEXT" | grep -qF "/verify?token=${SH}&type=${T}&redirect_to=" || { OK=0; WHY="${WHY} no /verify link"; } ;;
  esac
  case "$T" in
    magiclink|email|zz_future_type|reauthentication)
      printf '%s' "$TEXT" | grep -qF "$SC" || { OK=0; WHY="${WHY} no code"; } ;;
  esac
  case "$T" in
    reauthentication)
      printf '%s%s' "$TEXT" "$HTML" | grep -qF "/verify" && { OK=0; WHY="${WHY} has /verify"; } ;;
    *_notification)
      printf '%s%s' "$TEXT" "$HTML" | grep -qE "http|${SC}|${SH}" && { OK=0; WHY="${WHY} has link/token"; } ;;
  esac
  [[ "$OK" == "1" ]] && pass "${T} → 200 {}, 1 message, '${WANT_SUBJ}'" || fail "${T}:${WHY}"
done

# email_change, secure, both real: the swap proof
EC_A="zz_s166_eca${SFX}@local.test"; EC_B="zz_s166_ecb${SFX}@local.test"
TA=$(rand_code); TB=$(rand_code); HA="hashA$(rand_hex 10)"; HB="hashB$(rand_hex 10)"
remember "$EC_A" "$EC_B" "$TA" "$TB" "$HA" "$HB"
mp_clear
# GoTrue semantics: token_hash_new pairs with the CURRENT address + token;
# token_hash pairs with the NEW address + token_new.
hook_signed "$(syn_payload email_change "$EC_A" "$EC_B" "$TA" "$HB" "$TB" "$HA")"
if [[ "$CODE" == "200" ]] && mp_wait 2; then
  TA_TEXT=$(mp_msg "$EC_A" | jq -r '.Text'); TB_TEXT=$(mp_msg "$EC_B" | jq -r '.Text')
  if printf '%s' "$TA_TEXT" | grep -qF "token=${HA}&type=email_change" && printf '%s' "$TA_TEXT" | grep -qF "$TA" \
     && printf '%s' "$TB_TEXT" | grep -qF "token=${HB}&type=email_change" && printf '%s' "$TB_TEXT" | grep -qF "$TB" \
     && ! printf '%s' "$TA_TEXT" | grep -qF "$HB" && ! printf '%s' "$TB_TEXT" | grep -qF "$HA"; then
    pass "email_change secure → 2 messages; current gets token_hash_new+token, new gets token_hash+token_new"
  else
    fail "email_change secure: swapped-hash pairing wrong"
  fi
else
  fail "email_change secure → HTTP $CODE, Mailpit total $(mp_total) (expected 2)"
fi

mp_clear
HS="hashS$(rand_hex 10)"; CODE_SINGLE=$(rand_code); remember "$HS" "$CODE_SINGLE"
hook_signed "$(syn_payload email_change "$EC_A" "$EC_B" "$CODE_SINGLE" "$HS" "" "")"
if [[ "$CODE" == "200" ]] && mp_wait 1 && [[ "$(mp_count_to "$EC_B")" == "1" ]]; then
  pass "email_change single pair → 1 message, to new_email"
else
  fail "email_change single pair → HTTP $CODE, total $(mp_total)"
fi

if [[ -n "$PH_EMAIL" ]]; then
  mp_clear
  hook_signed "$(syn_payload email_change "$PH_EMAIL" "$EC_B" "$TA" "$HB" "$TB" "$HA")"
  if [[ "$CODE" == "200" ]] && mp_wait 1 && [[ "$(mp_count_to "$EC_B")" == "1" ]]; then
    pass "email_change placeholder current + real new → exactly 1, to the real new address"
  else
    fail "email_change placeholder current + real new → HTTP $CODE, total $(mp_total)"
  fi

  mp_clear
  hook_signed "$(syn_payload email_change "$EC_A" "$PH_EMAIL" "$TA" "$HB" "$TB" "$HA")"
  if [[ "$CODE" == "200" ]] && mp_wait 1 && [[ "$(mp_count_to "$EC_A")" == "1" ]]; then
    pass "email_change real current + placeholder new → exactly 1, to the real current address"
  else
    fail "email_change real current + placeholder new → HTTP $CODE, total $(mp_total)"
  fi

  mp_clear
  PH_FAILS=""
  for T in recovery signup invite magiclink email reauthentication email_change \
           password_changed_notification email_changed_notification phone_changed_notification \
           identity_linked_notification identity_unlinked_notification \
           mfa_factor_enrolled_notification mfa_factor_unenrolled_notification zz_future_type; do
    NE=""; HN=""
    [[ "$T" == "email_change" ]] && { NE="$PH_EMAIL"; HN="$HA"; }
    hook_signed "$(syn_payload "$T" "$PH_EMAIL" "$NE" "$TA" "$HB" "$TB" "$HN")"
    [[ "$CODE" == "200" && "$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)" == "{}" ]] || PH_FAILS="${PH_FAILS} ${T}=${CODE}"
  done
  hook_signed "$(syn_payload email_changed_notification "$SYN" "" "" "" "" "" "$PH_EMAIL")"
  [[ "$CODE" == "200" ]] || PH_FAILS="${PH_FAILS} email_changed_notification(old_email)=${CODE}"
  if [[ -z "$PH_FAILS" ]] && mp_wait 0; then
    pass "every type addressed to the placeholder (+ placeholder old_email) → 200 {}, Mailpit total 0"
  else
    fail "placeholder-addressed payloads:${PH_FAILS:- ok} total=$(mp_total)"
  fi
else
  fail "S6 placeholder sub-arms skipped: no placeholder fixture"
fi

################################################################################
step "S10: transport rejects a real recipient → 500 delivery failed, 0 mails"
# Spec 168 item 3 — the handler's fail-closed delivery path, live. The
# recipient "not-an-address" is real (not the spec 165 placeholder shape), a
# non-empty string, passes parsePayload and routeLegs, and renders (recovery:
# syn_payload supplies a usable redirect_to and the hash), so the request
# genuinely reaches the transport. Mailpit's /api/v1/send rejects it with
# HTTP 400 {"Error":"invalid To address: not-an-address"} — established
# 2026-10-21 from the host and from inside the stack's Docker network (the
# hook's own MAILPIT_SEND_URL host). No config.toml, hook-code or Mailpit
# change manufactures the failure. If Mailpit ever accepts the address, the
# precondition below FAILs loudly instead of passing falsely.
# Signed synthetic payload, no GoTrue → no /recover rate-limit pressure. The
# remembered address / hash / code let S7 prove none leaks on this path.
BAD_TO="not-an-address"
SH="synhash$(rand_hex 12)"; SC=$(rand_code)
remember "$BAD_TO" "$SH" "$SC"
EDGE_FROM=$(docker exec "$EDGE_CONTAINER" printenv SEND_EMAIL_FROM 2>/dev/null)
MP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${MAILPIT_URL}/api/v1/send" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg f "$EDGE_FROM" --arg t "$BAD_TO" '{From:{Email:$f}, To:[{Email:$t}], Subject:"s168 probe", Text:"x"}')" 2>/dev/null)
# An empty From would make Mailpit reject the probe for the wrong reason.
if [[ -z "$EDGE_FROM" ]]; then
  fail "precondition: could not read SEND_EMAIL_FROM from ${EDGE_CONTAINER}, so the Mailpit probe proves nothing"
elif [[ -z "$MP_CODE" || "$MP_CODE" == "000" ]]; then
  fail "precondition: direct Mailpit /api/v1/send probe got no HTTP response"
elif [[ "$MP_CODE" == 2* ]]; then
  fail "Mailpit now accepts '${BAD_TO}' (HTTP ${MP_CODE}) — spec 168 item 3 needs a new rejected recipient; return to the architect"
else
  pass "precondition: Mailpit /api/v1/send rejects '${BAD_TO}' → HTTP ${MP_CODE}"
  mp_clear
  [[ "$(mp_total)" == "0" ]] && pass "Mailpit cleared before S10" || fail "Mailpit not empty before S10"
  S10_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sleep 1
  hook_signed "$(syn_payload recovery "$BAD_TO" "" "$SC" "$SH" "" "")"
  [[ "$CODE" == "500" && "$(printf '%s' "$BODY" | jq -c '.' 2>/dev/null)" == '{"error":"delivery failed"}' ]] \
    && pass "signed recovery to '${BAD_TO}' → 500 {\"error\":\"delivery failed\"}" \
    || fail "signed recovery to '${BAD_TO}' → HTTP $CODE body=$BODY (expected 500 delivery failed)"
  mp_wait 0 && pass "Mailpit total = 0 after the rejected send" || fail "Mailpit total = $(mp_total) after the rejected send"
  S10_N=0
  for ((i = 0; i < 20; i++)); do
    S10_N=$(docker logs --since "$S10_START" "$EDGE_CONTAINER" 2>&1 | sed -E 's/^[^{]*//' | grep '{' \
      | jq -cR --argjson st "$MP_CODE" 'fromjson? | select(.hook=="auth-email-hook" and .action=="recovery"
          and .outcome=="failed" and .reason=="transport" and (.status|type)=="number" and .status==$st
          and .recipients==1 and .dropped==0)' 2>/dev/null | grep -c '{')
    [[ "$S10_N" == "1" ]] && break
    sleep 0.25
  done
  [[ "$S10_N" == "1" ]] \
    && pass "hook logged outcome:failed reason:transport status:${MP_CODE} (recipients 1, dropped 0)" \
    || fail "expected exactly 1 matching outcome:failed/transport/status:${MP_CODE} log line, found ${S10_N}"
fi

################################################################################
step "S6b: real GoTrue invite → the /verify link redeems"
mp_clear
INV="zz_s166_inv${SFX}@local.test"
remember "$INV"
INV_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "${SUPABASE_URL}/auth/v1/invite?redirect_to=$(jq -rn '"http://localhost:8081/register"|@uri')" \
  -H "apikey: ${SERVICE_KEY}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg e "$INV" '{email:$e}')")
[[ "$INV_CODE" == "200" ]] && pass "POST /auth/v1/invite → 200" || fail "POST /auth/v1/invite → HTTP $INV_CODE"
if mp_wait 1; then
  INV_MSG=$(mp_msg "$INV")
  [[ "$(printf '%s' "$INV_MSG" | jq -r '.Subject')" == "You have been invited to I.M.R" ]] \
    && pass "invite subject" || fail "invite subject = '$(printf '%s' "$INV_MSG" | jq -r '.Subject')'"
  LINK=$(printf '%s' "$INV_MSG" | jq -r '.Text' | grep -oE 'https?://[^[:space:]]+/verify\?token=[^[:space:]]+' | head -1)
  INV_HASH=$(printf '%s' "$LINK" | sed -nE 's/.*[?&]token=([^&]+).*/\1/p')
  remember "$INV_HASH"
  case "$LINK" in
    http://kong:8000/*) D11_BRANCH="SUPABASE_URL fallback (site_url not API-shaped; host kong:8000)"
                        LINK="http://127.0.0.1:54321${LINK#http://kong:8000}" ;;
    "") D11_BRANCH="none (no link)" ;;
    *) D11_BRANCH="site_url (API-shaped: ${LINK%%/verify*})" ;;
  esac
  printf '         D11 verifyBase branch taken: %s\n' "$D11_BRANCH"
  if [[ -n "$LINK" ]]; then
    HDRS=$(curl -sS -o /dev/null -D - "$LINK")
    STATUS=$(printf '%s' "$HDRS" | head -1 | awk '{print $2}')
    LOC=$(printf '%s' "$HDRS" | grep -i '^location:' | tr -d '\r')
    if [[ "$STATUS" == "303" ]] && printf '%s' "$LOC" | grep -qF 'access_token=' && printf '%s' "$LOC" | grep -qF 'localhost:8081/register'; then
      pass "GET invite link → 303 to localhost:8081/register with access_token"
    else
      fail "GET invite link → HTTP ${STATUS} (location has access_token: $(printf '%s' "$LOC" | grep -c access_token=))"
    fi
  else
    fail "invite mail has no /verify link"
  fi
else
  fail "invite: Mailpit total = $(mp_total) (expected 1)"
fi

################################################################################
step "S9: real secure email change → both legs' hashes are GoTrue's and each redeems"
# Local GoTrue runs with MAILER_AUTOCONFIRM=true (enable_confirmations = false),
# so the FIRST redeemed leg completes a secure email change and the other leg's
# hash is consumed with it (a second /verify would 403). The arm therefore
# proves the pairing against GoTrue's own state (old-leg hash =
# email_change_token_current, new-leg hash = email_change_token_new), then
# runs two changes: one redeemed via the current-address leg, one via the
# new-address leg. Each leg's hash must redeem on its own.
# Spec 168 (architect m4): that mechanics needs autoconfirm, so the arm reads
# GOTRUE_MAILER_AUTOCONFIRM first. Exactly `true` → the two rounds above,
# unchanged. Anything else (empty / unreadable included) → ONE hash-equality
# round (no redemption) plus a SKIP for the redemption half; there is no
# second round because it would start from the changed address. The pending
# change is removed with the fixture by the EXIT trap.
NEW_FX="zz_s166_n${SFX}@local.test"
NEW_FX2="zz_s166_m${SFX}@local.test"
remember "$NEW_FX" "$NEW_FX2"
FX_BEARER=$(curl -sS -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg e "$REAL_FX" --arg p "$REAL_FX_PW" '{email:$e,password:$p}')" | jq -r '.access_token // empty')

S9_AC_NOTE=""
[[ -n "${S9_AUTOCONFIRM_OVERRIDE+x}" ]] && S9_AC_NOTE=" (S9_AUTOCONFIRM_OVERRIDE)"
AC="${S9_AUTOCONFIRM_OVERRIDE-$(docker exec "$AUTH_CONTAINER" printenv GOTRUE_MAILER_AUTOCONFIRM 2>/dev/null)}"
printf '         S9 precondition: GOTRUE_MAILER_AUTOCONFIRM=%s%s\n' "'${AC}'" "$S9_AC_NOTE"

# email_change_round <from> <to> <redeem: old|new|none>  (none = hash-equality only)
email_change_round() {
  local from="$1" to="$2" which="$3" put_code old_h new_h db_cur db_new db_email h label
  [[ "$which" == "none" ]] && label="hash-equality round" || label="${which}-leg round"
  mp_clear
  put_code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "${SUPABASE_URL}/auth/v1/user" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${FX_BEARER}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg e "$to" '{email:$e}')")
  [[ "$put_code" == "200" ]] && pass "PUT /auth/v1/user {email} (${label}) → 200" || { fail "PUT /auth/v1/user → HTTP $put_code"; return; }
  if ! mp_wait 2; then fail "email change: Mailpit total = $(mp_total) (expected 2)"; return; fi
  old_h=$(mp_msg "$from" | jq -r '.Text' | sed -nE 's/.*\/verify\?token=([^&]+)&type=email_change.*/\1/p' | head -1)
  new_h=$(mp_msg "$to" | jq -r '.Text' | sed -nE 's/.*\/verify\?token=([^&]+)&type=email_change.*/\1/p' | head -1)
  remember "$old_h" "$new_h"
  if [[ -z "$old_h" || -z "$new_h" ]]; then fail "email_change mails lack /verify links"; return; fi
  pass "one message to the old address, one to the new"
  db_cur=$(psql_q "select email_change_token_current from auth.users where email = '${from}'")
  db_new=$(psql_q "select email_change_token_new from auth.users where email = '${from}'")
  [[ "$old_h" == "$db_cur" && "$new_h" == "$db_new" ]] \
    && pass "old-leg hash = email_change_token_current, new-leg hash = email_change_token_new (swap matches GoTrue)" \
    || fail "email_change hash pairing does not match GoTrue's stored tokens"
  [[ "$which" == "none" ]] && return
  [[ "$which" == "old" ]] && h="$old_h" || h="$new_h"
  verify_hash email_change "$h"
  [[ "$CODE" == "200" ]] && pass "${which}-leg token_hash redeems (/verify → 200)" || fail "${which}-leg /verify → HTTP $CODE"
  db_email=$(psql_q "select email from auth.users where email in ('${from}','${to}')")
  [[ "$db_email" == "$to" ]] && pass "auth.users.email = the new address" || fail "auth.users.email = '${db_email}'"
}

if [[ -n "$FX_BEARER" ]]; then
  if [[ "$AC" == "true" ]]; then
    email_change_round "$REAL_FX" "$NEW_FX" old
    sleep 2
    email_change_round "$NEW_FX" "$NEW_FX2" new
  else
    email_change_round "$REAL_FX" "$NEW_FX" none
    skip "S9 redemption" "GOTRUE_MAILER_AUTOCONFIRM='${AC}'${S9_AC_NOTE}; the first-leg-completes-change mechanics need autoconfirm"
  fi
else
  fail "could not sign in the real-email fixture"
fi

################################################################################
step "S7: hygiene — hook bodies and edge logs"
sleep 1
LEAKS=0
while IFS= read -r s; do
  [[ -z "$s" ]] && continue
  grep -qF -- "$s" "$BODIES_FILE" && LEAKS=$((LEAKS + 1))
done < "$SECRETS_FILE"
grep -qF 'no-email.invalid' "$BODIES_FILE" && LEAKS=$((LEAKS + 1))
[[ "$LEAKS" == "0" ]] && pass "no hook response body contains a token, hash, address or no-email.invalid" \
  || fail "${LEAKS} secret(s) found in hook response bodies"

EDGE_LOGS=$(docker logs --since "$SMOKE_START" "$EDGE_CONTAINER" 2>&1)
LOG_LEAKS=0
while IFS= read -r s; do
  [[ -z "$s" || "$s" =~ ^[0-9]{6}$ ]] && continue   # 6-digit codes collide with timestamps
  printf '%s' "$EDGE_LOGS" | grep -qF -- "$s" && LOG_LEAKS=$((LOG_LEAKS + 1))
done < "$SECRETS_FILE"
printf '%s' "$EDGE_LOGS" | grep -qF 'no-email.invalid' && LOG_LEAKS=$((LOG_LEAKS + 1))
[[ "$LOG_LEAKS" == "0" ]] && pass "edge-runtime logs for the smoke window contain no hash, fixture address or no-email.invalid" \
  || fail "${LOG_LEAKS} secret(s) found in edge-runtime logs"

HOOK_LINES=$(printf '%s\n' "$EDGE_LOGS" | grep -F '"hook":"auth-email-hook"' | sed -E 's/^[^{]*//')
N_LINES=$(printf '%s\n' "$HOOK_LINES" | grep -c '{' || true)
BAD_LINES=$(printf '%s\n' "$HOOK_LINES" | grep '{' | jq -c 'keys - ["hook","action","outcome","recipients","dropped","status","reason"] | select(length > 0)' 2>/dev/null | wc -l | tr -d ' ')
NON_JSON=$(printf '%s\n' "$HOOK_LINES" | grep '{' | while IFS= read -r l; do printf '%s' "$l" | jq -e . >/dev/null 2>&1 || echo x; done | wc -l | tr -d ' ')
if [[ "$N_LINES" -gt 0 && "$BAD_LINES" == "0" && "$NON_JSON" == "0" ]]; then
  pass "${N_LINES} hook log lines, all JSON with keys ⊆ {hook,action,outcome,recipients,dropped,status,reason}"
else
  fail "hook log lines: ${N_LINES} total, ${BAD_LINES} with extra keys, ${NON_JSON} non-JSON"
fi

################################################################################
step "S8: prod-transport proof"
skip "S8" "prod transport proven by src/lib/authEmailHook.test.ts — spec 166 D10"

printf '\n'
if [[ "$FAILED" == "0" ]]; then printf '\033[32mALL ARMS PASSED\033[0m\n'; else printf '\033[31mSOME ARMS FAILED\033[0m\n'; fi
exit "$FAILED"
