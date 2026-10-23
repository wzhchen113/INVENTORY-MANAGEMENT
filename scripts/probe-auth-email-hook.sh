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
# Key handling (spec 168, closes security L1): the secret comes from the env or
# the no-echo prompt and only ever travels through pipes: `openssl base64 -d`
# decodes it from stdin, and the decoded key reaches `node` (which computes the
# HMAC-SHA256) only on stdin. Neither the secret nor the key is on any
# process's argv. HOOK_SECRET is unset as soon as it is copied, and SECRET
# before node runs, so node's environment never holds it.
# Requires node, openssl, jq and curl.
#
# Exit code: 0 on HTTP 200 {}, non-zero otherwise.

set -u

URL=""
TO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
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
# Checked before the secret is read or prompted for, so the owner is never
# asked for a secret that then cannot be used.
command -v node >/dev/null 2>&1 || die "node is required on PATH to sign the probe"

# A SECRET / KEY_HEX already exported by the caller's shell would stay exported
# after reassignment and leak into child environments; drop them first.
unset SECRET KEY_HEX
SECRET="${HOOK_SECRET:-}"
unset HOOK_SECRET
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

KEY_HEX=$(printf '%s' "${SECRET#v1,whsec_}" | openssl base64 -d -A 2>/dev/null | od -An -v -tx1 | tr -d ' \n')
[[ -n "$KEY_HEX" ]] || die "HOOK_SECRET did not base64-decode"
unset SECRET HOOK_SECRET

BODY=$(jq -cn --arg e "$TO_NORM" \
  '{user:{id:"00000000-0000-0000-0000-000000000000", email:$e, new_email:""},
    email_data:{token:"", token_hash:"", redirect_to:"", email_action_type:"zz_preflight_probe",
                site_url:"", token_new:"", token_hash_new:"", old_email:""}}')
MSG_ID="msg_probe_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
TS=$(date +%s)
# stdin = <lower-hex key> LF <message bytes>; split at the FIRST LF and HMAC the
# raw message bytes. stdout = padded base64, no newline (as `openssl base64 -A`).
# A bad key line exits non-zero with nothing on stdout. No secret in this text.
HMAC_JS='
const d = require("fs").readFileSync(0);
const nl = d.indexOf(10);
if (nl < 0) process.exit(2);
const k = d.subarray(0, nl).toString("latin1");
if (k === "" || !/^[0-9a-f]+$/.test(k) || k.length % 2 !== 0) process.exit(2);
process.stdout.write(require("crypto").createHmac("sha256", Buffer.from(k, "hex")).update(d.subarray(nl + 1)).digest("base64"));
'
SIG=$(printf '%s\n%s' "$KEY_HEX" "${MSG_ID}.${TS}.${BODY}" | node -e "$HMAC_JS")
unset KEY_HEX
[[ -n "$SIG" ]] || die "could not compute the signature"

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
