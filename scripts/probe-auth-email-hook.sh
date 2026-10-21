#!/usr/bin/env bash
# scripts/probe-auth-email-hook.sh — Spec 166 D15, MANDATORY owner-run
# pre-enable probe for the GoTrue Send Email hook (runbook §12 step 5b).
#
# Sends ONE Standard-Webhooks-signed `zz_preflight_probe` payload straight to
# the deployed auth-email-hook function, addressed to an owner-controlled
# inbox, WHILE THE HOOK IS STILL DISABLED in the dashboard. The function
# renders it as the generic "Account notification" fallback with no link and
# no code. A 200 {} plus one mail arriving from the expected From proves, before
# any user is affected: the hook secret matches, the transport works, the From
# address is set, and the sending domain is verified.
#
# Usage (prod; the owner runs this, never CI). Leave HOOK_SECRET unset and the
# script prompts for it without echo (keeps it out of shell history):
#   bash scripts/probe-auth-email-hook.sh \
#     --url https://<project-ref>.supabase.co/functions/v1/auth-email-hook \
#     --to owner@example.com
# Non-interactive alternative: `read -rs HOOK_SECRET && export HOOK_SECRET`
# first, then run the same command. Never type HOOK_SECRET='…' inline.
#
# HOOK_SECRET is the same value as the function's SEND_EMAIL_HOOK_SECRET
# (single part, no "|" rotation list). It is never echoed. Not part of `npm
# run test:smoke`.
#
# Exposure note (security L1): the decoded key is passed to openssl as
# `-macopt hexkey:<hex>`, so it is visible in `ps` to other local users for the
# few milliseconds the openssl process runs. Acceptable on a single-user
# machine; do not run this on a shared host.
#
# Exit code: 0 on HTTP 200 {}, non-zero otherwise.

set -u

URL=""
TO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
done

die() { printf '\033[31mREFUSE\033[0m %s\n' "$1" >&2; exit 2; }

[[ -n "$URL" && -n "$TO" ]] || die "both --url and --to are required (see --help)"
case "$URL" in
  https://*/functions/v1/auth-email-hook) ;;
  http://127.0.0.1:*/functions/v1/auth-email-hook|http://localhost:*/functions/v1/auth-email-hook) ;;
  *) die "--url must be https://…/functions/v1/auth-email-hook (or a local http://127.0.0.1 / localhost URL)" ;;
esac
TO_NORM=$(printf '%s' "$TO" | tr '[:upper:]' '[:lower:]' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
[[ "$TO_NORM" =~ ^[^[:space:]@\<\>\"]+@[^[:space:]@\<\>\"]+$ ]] || die "--to is not an email address"
# Spec 165 placeholder shape: the hook would (correctly) drop it, which proves nothing.
[[ "$TO_NORM" =~ ^u-[0-9a-f]{32}@no-email\.invalid$ ]] && die "--to is a username-only placeholder address; use a real owner inbox"

SECRET="${HOOK_SECRET:-}"
if [[ -z "$SECRET" ]]; then
  [[ -t 0 ]] || die "HOOK_SECRET is not set and stdin is not a terminal to prompt for it"
  read -rs -p 'HOOK_SECRET (input hidden): ' SECRET
  printf '\n' >&2
fi
[[ -n "$SECRET" ]] || die "HOOK_SECRET is empty"
[[ "$SECRET" =~ ^v1,whsec_[A-Za-z0-9+/=]{32,88}$ ]] || die "HOOK_SECRET is not a single v1,whsec_<base64> secret"
case "$SECRET" in
  *LOCAL/DEV/ONLY*)
    case "$URL" in https://*) die "HOOK_SECRET is the committed LOCAL dev secret; prod uses the dashboard-generated one" ;; esac ;;
esac

KEY_HEX=$(printf '%s' "${SECRET#v1,whsec_}" | openssl base64 -d -A 2>/dev/null | od -An -tx1 | tr -d ' \n')
[[ -n "$KEY_HEX" ]] || die "HOOK_SECRET did not base64-decode"
unset SECRET HOOK_SECRET

BODY=$(jq -cn --arg e "$TO_NORM" \
  '{user:{id:"00000000-0000-0000-0000-000000000000", email:$e, new_email:""},
    email_data:{token:"", token_hash:"", redirect_to:"", email_action_type:"zz_preflight_probe",
                site_url:"", token_new:"", token_hash_new:"", old_email:""}}')
MSG_ID="msg_probe_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
TS=$(date +%s)
SIG=$(printf '%s' "${MSG_ID}.${TS}.${BODY}" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${KEY_HEX}" -binary | openssl base64 -A)
unset KEY_HEX

OUT=$(curl -sS --max-time 15 -w '\n%{http_code}' -X POST "$URL" -H "Content-Type: application/json" \
  -H "webhook-id: ${MSG_ID}" -H "webhook-timestamp: ${TS}" -H "webhook-signature: v1,${SIG}" \
  --data-binary "$BODY")
CODE=$(printf '%s' "$OUT" | tail -1)
RESP=$(printf '%s' "$OUT" | sed '$d')

if [[ "$CODE" == "200" && "$(printf '%s' "$RESP" | jq -c '.' 2>/dev/null)" == "{}" ]]; then
  printf '\033[32mOK\033[0m hook accepted the signed probe (HTTP 200 {}).\n'
  printf '   Now confirm ONE "Account notification" mail arrived at the --to inbox from the expected From.\n'
  exit 0
fi

ERR=$(printf '%s' "$RESP" | jq -r '.error // .message // .msg // empty' 2>/dev/null)
printf '\033[31mFAIL\033[0m HTTP %s %s\n' "$CODE" "${ERR:+($ERR)}"
case "$CODE:$ERR" in
  "401:invalid signature") printf '   The function rejected the signature: HOOK_SECRET differs from the function'"'"'s SEND_EMAIL_HOOK_SECRET.\n' ;;
  401:*) printf '   A non-function 401 means the gateway JWT check is on: redeploy with --no-verify-jwt.\n' ;;
  "500:hook misconfigured") printf '   SEND_EMAIL_HOOK_SECRET on the function is unset, malformed or not valid padded base64 (mis-pasted?).\n' ;;
  "500:delivery failed") printf '   Transport failed: check SEND_EMAIL_TRANSPORT / SEND_EMAIL_FROM / RESEND_API_KEY and the Resend domain; see the function logs (reason field).\n' ;;
esac
printf '   Do NOT enable the hook until this probe passes (spec 166 §12 step 5b).\n'
exit 1
