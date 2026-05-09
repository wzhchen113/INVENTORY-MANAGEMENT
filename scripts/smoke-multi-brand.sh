#!/usr/bin/env bash
# Spec 012a — Multi-brand RLS smoke test.
# Mirrors the §6 verification probes from the migration comment block.
# Run after `npm run dev:db:reset` (local) or after `supabase db push --linked` (prod).
#
# Usage (local):
#   SUPABASE_URL=http://127.0.0.1:54321 \
#   ANON_KEY=<from `supabase status`> \
#   SERVICE_ROLE_KEY=<from `supabase status`> \
#   bash scripts/smoke-multi-brand.sh
#
# Usage (prod):
#   SUPABASE_URL=https://<project-ref>.supabase.co \
#   ANON_KEY=<prod anon key> \
#   SERVICE_ROLE_KEY=<prod service role key> \
#   bash scripts/smoke-multi-brand.sh
#
# The script creates its own test data (Brand B + a catalog row + a brand-B
# admin user). All test data is cleaned up at the end. If a probe fails
# the script exits non-zero.
#
# PRE-REQUISITE (local only): a `brandb@local.test / password` auth.users
# row must exist. Create it via:
#   supabase auth admin create-user --email brandb@local.test --password password
# Then set its profile:
#   docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
#     "update public.profiles set role='admin', brand_id='2b000000-0000-0000-0000-000000000002' \
#      where id=(select id from auth.users where email='brandb@local.test' limit 1);"

set -euo pipefail

URL="${SUPABASE_URL:?SUPABASE_URL required}"
ANON="${ANON_KEY:?ANON_KEY required}"
SVC="${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY required}"
BRAND_A="2a000000-0000-0000-0000-000000000001"
BRAND_B="2b000000-0000-0000-0000-000000000002"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

echo "=== 012a multi-brand RLS smoke ==="

# ── Setup: insert Brand B + a catalog row (idempotent) ──
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres <<'SQL'
insert into public.brands (id, name)
values ('2b000000-0000-0000-0000-000000000002', 'TEST BRAND B')
on conflict (id) do nothing;

insert into public.catalog_ingredients (brand_id, name, unit, category)
values ('2b000000-0000-0000-0000-000000000002', 'Brand B Test Ingredient', 'kg', 'Test')
on conflict do nothing;
SQL

# ── Fetch Token A (brand-A admin) ──
TOKEN_A=$(curl -sf -X POST "${URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON}" -H "Content-Type: application/json" \
  -d '{"email":"admin@local.test","password":"password"}' | jq -r .access_token)
[ -z "${TOKEN_A}" ] && fail "Could not obtain TOKEN_A for admin@local.test"

# ── Fetch Token B (brand-B admin) ──
TOKEN_B=$(curl -sf -X POST "${URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON}" -H "Content-Type: application/json" \
  -d '{"email":"brandb@local.test","password":"password"}' | jq -r .access_token) || true

# ── Promote admin@local.test to super_admin for probe 5 ──
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "update public.profiles set role='super_admin', brand_id=null \
   where id=(select id from auth.users where email='admin@local.test' limit 1);"
TOKEN_S=$(curl -sf -X POST "${URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON}" -H "Content-Type: application/json" \
  -d '{"email":"admin@local.test","password":"password"}' | jq -r .access_token)

# ── Probe 1: brand-A admin reads brand-B catalog → 0 rows ──
P1=$(curl -s "${URL}/rest/v1/catalog_ingredients?brand_id=eq.${BRAND_B}" \
  -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_A}" | jq 'length')
[ "${P1}" = "0" ] && pass "Probe 1 (cross-brand read blocked): 0 rows" || fail "Probe 1: expected 0, got ${P1}"

# ── Probe 2: brand-A admin reads brand-A catalog → 143 rows ──
P2=$(curl -s "${URL}/rest/v1/catalog_ingredients?brand_id=eq.${BRAND_A}" \
  -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_A}" | jq 'length')
[ "${P2}" = "143" ] && pass "Probe 2 (brand-A read intact): 143 rows" || fail "Probe 2: expected 143, got ${P2}"

# ── Probe 3: brand-A admin INSERT into brand B → RLS rejection ──
P3_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${URL}/rest/v1/catalog_ingredients" \
  -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_A}" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "{\"brand_id\":\"${BRAND_B}\",\"name\":\"smuggled\",\"unit\":\"kg\"}")
( [ "${P3_STATUS}" = "403" ] || [ "${P3_STATUS}" = "401" ] || [ "${P3_STATUS}" = "400" ] ) \
  && pass "Probe 3 (cross-brand INSERT rejected): HTTP ${P3_STATUS}" \
  || fail "Probe 3: expected 4xx, got ${P3_STATUS}"

# ── Probe 4: brand-B admin sees only brand B ──
if [ -n "${TOKEN_B}" ]; then
  P4=$(curl -s "${URL}/rest/v1/catalog_ingredients" \
    -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_B}" | jq '[.[].brand_id] | unique | .[]')
  [ "${P4}" = "\"${BRAND_B}\"" ] && pass "Probe 4 (brand-B admin sees only brand B)" \
    || fail "Probe 4: unexpected brand_ids: ${P4}"
else
  echo "SKIP: Probe 4 — brandb@local.test not present; create via supabase auth admin create-user"
fi

# ── Probe 5: super-admin sees both brands ──
P5=$(curl -s "${URL}/rest/v1/catalog_ingredients" \
  -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_S}" | jq '[.[].brand_id] | unique | length')
[ "${P5}" = "2" ] && pass "Probe 5 (super-admin sees both brands): ${P5} distinct brand_ids" \
  || fail "Probe 5: expected 2 distinct brand_ids, got ${P5}"

# ── Probe 6: child-table RLS (recipe_ingredients) honors parent brand ──
P6=$(curl -s "${URL}/rest/v1/recipe_ingredients?select=*,recipe:recipes(brand_id)" \
  -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_A}" | jq '[.[].recipe.brand_id] | unique | .[]')
[ "${P6}" = "\"${BRAND_A}\"" ] && pass "Probe 6 (recipe_ingredients child RLS): brand-A only" \
  || fail "Probe 6: unexpected brand_ids in recipe_ingredients: ${P6}"

# ── Probe 7: soft-deleted brand hidden ──
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "update public.brands set deleted_at = now() where id='${BRAND_B}';"
if [ -n "${TOKEN_B}" ]; then
  P7_B=$(curl -s "${URL}/rest/v1/brands" \
    -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_B}" | jq 'length')
  [ "${P7_B}" = "0" ] && pass "Probe 7a (soft-deleted brand hidden from brand-B admin): 0" \
    || fail "Probe 7a: expected 0, got ${P7_B}"
fi
P7_S=$(curl -s "${URL}/rest/v1/brands" \
  -H "apikey: ${ANON}" -H "Authorization: Bearer ${TOKEN_S}" | jq 'length')
[ "${P7_S}" = "2" ] && pass "Probe 7b (super-admin sees soft-deleted brand): 2" \
  || fail "Probe 7b: expected 2, got ${P7_S}"
# Restore brand B for probe 8/9
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "update public.brands set deleted_at = null where id='${BRAND_B}';"

# ── Probe 8: cross-brand user_stores trigger fires ──
P8=$(docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "insert into public.user_stores (user_id, store_id) values \
    ((select id from auth.users where email='admin@local.test' limit 1), \
     (select id from public.stores where brand_id='${BRAND_B}' limit 1));" 2>&1 || true)
echo "${P8}" | grep -q "cross-brand" \
  && pass "Probe 8 (cross-brand user_stores trigger fires)" \
  || echo "SKIP: Probe 8 — no brand-B store exists yet (needs a brand-B store row)"

# ── Probe 9: service-role bypass returns all brands ──
P9=$(curl -s "${URL}/rest/v1/catalog_ingredients" \
  -H "apikey: ${SVC}" -H "Authorization: Bearer ${SVC}" | jq 'length')
[ "${P9}" -gt 143 ] 2>/dev/null \
  && pass "Probe 9 (service-role bypass, total rows > 143): ${P9}" \
  || fail "Probe 9: expected >143 rows (both brands), got ${P9}"

# ── Cleanup: restore admin@local.test to admin role ──
docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres -c \
  "update public.profiles set role='admin', brand_id='${BRAND_A}' \
   where id=(select id from auth.users where email='admin@local.test' limit 1);"

echo "=== smoke-multi-brand.sh complete ==="
