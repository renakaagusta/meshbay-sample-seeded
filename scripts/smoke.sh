#!/usr/bin/env bash
# Smoke test for meshbay-sample-seeded.
#
#   scripts/smoke.sh <url> [expected-seed-runs]
#
# expected-seed-runs is optional: pass the number /meta reported before the
# deploy when checking that a redeploy seeded again (it must grow by one).
set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: scripts/smoke.sh <url> [expected-seed-runs]" >&2
  exit 2
fi

baseUrl="${1%/}"
expectedSeedRuns="${2:-}"

if [[ -n "$expectedSeedRuns" && ! "$expectedSeedRuns" =~ ^[0-9]+$ ]]; then
  echo "FAIL expected-seed-runs must be a number, got '$expectedSeedRuns'" >&2
  exit 2
fi

for command in curl jq; do
  command -v "$command" > /dev/null || { echo "FAIL $command is required" >&2; exit 1; }
done

responseFile="$(mktemp)"
trap 'rm -f "$responseFile"' EXIT

statusCode=""

showResponse() {
  if [[ -s "$responseFile" ]]; then
    echo "response: $(head -c 500 "$responseFile")" >&2
  fi
}

fail() {
  echo "FAIL $*" >&2
  showResponse
  exit 1
}

request() {
  statusCode="$(curl -s -m 20 -o "$responseFile" -w '%{http_code}' "$@")"
}

expectStatus() {
  local label="$1" expected="$2"
  if [[ "$statusCode" != "$expected" ]]; then
    echo "FAIL $label: expected HTTP $expected, got $statusCode" >&2
    showResponse
    exit 1
  fi
  echo "ok   $label ($statusCode)"
}

# --- health ------------------------------------------------------------------
request "$baseUrl/health"
expectStatus "GET /health" 200
jq -e . "$responseFile" > /dev/null 2>&1 || fail "/health did not return JSON"
[[ "$(jq -r '.status' "$responseFile")" == "ok" ]] || fail "/health status is not ok"
[[ "$(jq -r '.database' "$responseFile")" == "ok" ]] || fail "/health does not reach Postgres"
echo "ok   GET /health reaches Postgres"

# --- seeded reference data ---------------------------------------------------
request "$baseUrl/plans"
expectStatus "GET /plans" 200
jq -e 'type == "array"' "$responseFile" > /dev/null 2>&1 || fail "/plans did not return an array"
planCount="$(jq 'length' "$responseFile")"
[[ "$planCount" == "3" ]] || fail "/plans has $planCount rows, expected 3 (seed did not run, or ran twice)"
jq -e '
  [.[].code] | sort == ["growth", "scale", "starter"]
' "$responseFile" > /dev/null || fail "/plans does not hold the reference codes"
echo "ok   GET /plans returns 3 reference plans"

# --- metadata: last migration and number of seed executions -------------------
request "$baseUrl/meta"
expectStatus "GET /meta" 200
lastMigration="$(jq -r '.lastMigration // empty' "$responseFile")"
seedRuns="$(jq -r '.seedRuns // empty' "$responseFile")"
[[ -n "$lastMigration" ]] || fail "/meta has no lastMigration (migrate deploy never recorded one)"
[[ "$lastMigration" == "20261116090100_items_note" ]] \
  || fail "/meta reports migration '$lastMigration', expected 20261116090100_items_note"
[[ "$seedRuns" =~ ^[0-9]+$ ]] || fail "/meta has no seed run count"
(( seedRuns >= 1 )) || fail "/meta seedRuns is $seedRuns, expected at least 1"
if [[ -n "$expectedSeedRuns" ]]; then
  (( seedRuns == expectedSeedRuns )) \
    || fail "/meta seedRuns is $seedRuns, expected $expectedSeedRuns"
fi
[[ "$(jq -r '.plans' "$responseFile")" == "3" ]] || fail "/meta plan count is not 3"
echo "ok   GET /meta reports $lastMigration and $seedRuns seed run(s)"

# --- CRUD on /api/items, the path scripts/smoke-crud.sh uses -------------------
itemName="smoke-$(date +%s)"
itemNote="note-${itemName}"
renamedName="${itemName}-renamed"
renamedNote="note-${renamedName}"

request -X POST -H 'content-type: application/json' \
  -d "$(printf '{"name":"%s","note":"%s"}' "$itemName" "$itemNote")" "$baseUrl/api/items"
expectStatus "POST /api/items" 201
itemIdentifier="$(jq -r '.id // empty' "$responseFile")"
[[ -n "$itemIdentifier" ]] || fail "create returned no id"
[[ "$(jq -r '.name' "$responseFile")" == "$itemName" ]] || fail "create returned another name"
[[ "$(jq -r '.note' "$responseFile")" == "$itemNote" ]] || fail "create returned another note"

request "$baseUrl/api/items/$itemIdentifier"
expectStatus "GET /api/items/$itemIdentifier" 200
[[ "$(jq -r '.name' "$responseFile")" == "$itemName" ]] || fail "read returned another name"

request "$baseUrl/api/items"
expectStatus "GET /api/items lists it" 200
jq -e --arg wanted "$itemIdentifier" 'any(.[]; (.id | tostring) == $wanted)' "$responseFile" > /dev/null \
  || fail "list does not contain item $itemIdentifier"

request -X PUT -H 'content-type: application/json' \
  -d "$(printf '{"name":"%s","note":"%s"}' "$renamedName" "$renamedNote")" "$baseUrl/api/items/$itemIdentifier"
expectStatus "PUT /api/items/$itemIdentifier" 200
[[ "$(jq -r '.name' "$responseFile")" == "$renamedName" ]] || fail "update did not rename"
[[ "$(jq -r '.note' "$responseFile")" == "$renamedNote" ]] || fail "update did not rewrite the note"

request -X DELETE "$baseUrl/api/items/$itemIdentifier"
expectStatus "DELETE /api/items/$itemIdentifier" 204
request "$baseUrl/api/items/$itemIdentifier"
expectStatus "GET deleted item" 404

echo "OK plans=3 seedRuns=$seedRuns migration=$lastMigration on $baseUrl"
