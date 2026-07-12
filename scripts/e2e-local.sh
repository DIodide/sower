#!/usr/bin/env bash
# Full-permutation local e2e:
#   poll simplify -> NEEDS_INPUT -> discover api_calls recorded ->
#   seed resume document (@sower/storage local vault) + answers bank ->
#   requeue -> REVIEW -> approve (DRY RUN — nothing is ever submitted) ->
#   submit_dryrun api_call row referencing the resume storage path.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_URL="http://localhost:8080"
export DATABASE_URL="postgres://postgres:sower@localhost:5432/sower"
export INGEST_API_KEY="dev-key"
export QUEUE_DRIVER="inline"
export VAULT_LOCAL_DIR="$ROOT_DIR/.vault"
# SAFETY: dry-run only, local vault only.
export SOWER_SUBMIT_ENABLED="false"
unset VAULT_BUCKET || true

# Point at the fake sample profile wherever it lives.
if [ -f "$ROOT_DIR/config/profile.sample.yaml" ]; then
  export PROFILE_PATH="$ROOT_DIR/config/profile.sample.yaml"
elif [ -f "$ROOT_DIR/apps/api/config/profile.sample.yaml" ]; then
  export PROFILE_PATH="$ROOT_DIR/apps/api/config/profile.sample.yaml"
fi

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  echo "E2E FAIL"
  exit 1
}

# Evaluate a JS expression against JSON on stdin (bound as `data`, with env).
json_query() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      const data = JSON.parse(raw);
      const fn = new Function("data", "env", `return (${process.argv[1]});`);
      const result = fn(data, process.env);
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });
  ' "$1"
}

psql_exec() {
  docker compose exec -T postgres psql -U postgres -d sower -tA -c "$1"
}

echo "==> Starting postgres via docker compose"
docker compose up -d postgres || fail "start postgres"

echo "==> Waiting for postgres to become healthy"
for attempt in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U postgres -d sower >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    fail "postgres did not become healthy in time"
  fi
  sleep 1
done

echo "==> Running database migrations"
pnpm --filter @sower/db migrate || fail "database migrations"

echo "==> Resetting database for a reproducible run"
psql_exec "TRUNCATE api_calls, documents, answers, events, application_tasks, jobs;" \
  >/dev/null || fail "reset database"

echo "==> Starting API"
pnpm --filter @sower/api start &
API_PID=$!
cleanup() {
  kill "$API_PID" >/dev/null 2>&1 || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Waiting for API health"
for attempt in $(seq 1 60); do
  if curl -fsS "$API_URL/health" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    fail "API did not become healthy in time"
  fi
  sleep 1
done

echo "==> [1/7] Poll the Simplify source"
POLL_JSON="$(curl -fsS -X POST -H "x-api-key: $INGEST_API_KEY" \
  "$API_URL/sources/simplify/poll")" || fail "poll simplify (request failed)"
echo "$POLL_JSON"
INGESTED="$(echo "$POLL_JSON" | json_query 'data.ingested ?? 0')"
if [ "${INGESTED:-0}" -lt 1 ]; then
  fail "poll simplify (no greenhouse listings ingested)"
fi
pass "poll simplify (${INGESTED} listing(s) ingested)"

echo "==> [2/7] Wait for tasks to reach NEEDS_INPUT"
NEEDS_INPUT=0
for attempt in $(seq 1 45); do
  TASKS_JSON="$(curl -fsS -H "x-api-key: $INGEST_API_KEY" "$API_URL/tasks")" || TASKS_JSON='{"tasks":[]}'
  NEEDS_INPUT="$(echo "$TASKS_JSON" | json_query '(data.tasks ?? []).filter((t) => t.state === "NEEDS_INPUT").length')"
  PENDING="$(echo "$TASKS_JSON" | json_query '(data.tasks ?? []).filter((t) => t.state === "QUEUED" || t.state === "PREPARING").length')"
  if [ "$NEEDS_INPUT" -ge 1 ] && [ "$PENDING" -eq 0 ]; then
    break
  fi
  sleep 2
done
if [ "${NEEDS_INPUT:-0}" -lt 1 ]; then
  fail "tasks reach NEEDS_INPUT (none did)"
fi
pass "tasks reach NEEDS_INPUT (${NEEDS_INPUT} task(s))"

echo "==> [3/7] Verify api_calls rows were recorded for discover"
DISCOVER_CALLS="$(psql_exec "SELECT count(*) FROM api_calls WHERE phase = 'discover';")" || fail "query api_calls"
if [ "${DISCOVER_CALLS:-0}" -lt 1 ]; then
  fail "api_calls recorded for discover (0 rows)"
fi
pass "api_calls recorded for discover (${DISCOVER_CALLS} row(s))"

echo "==> [4/7] Seed resume document (@sower/storage) + answers bank for one task"
SEED_JSON="$(pnpm --filter @sower/api exec tsx scripts/e2e-seed.ts | tail -n 1)" ||
  fail "seed document + bank answers (seed script failed)"
echo "$SEED_JSON"
TASK_ID="$(echo "$SEED_JSON" | json_query 'data.taskId ?? ""')"
RESUME_PATH="$(echo "$SEED_JSON" | json_query 'data.resumePath ?? ""')"
if [ -z "$TASK_ID" ] || [ -z "$RESUME_PATH" ]; then
  fail "seed document + bank answers (missing taskId/resumePath in output)"
fi
if [ ! -f "$VAULT_LOCAL_DIR/$RESUME_PATH" ]; then
  fail "seed document + bank answers (resume file missing from local vault)"
fi
pass "seeded resume at ${RESUME_PATH} + bank answers for task ${TASK_ID}"

echo "==> [5/7] Requeue the task"
REQUEUE_JSON="$(curl -fsS -X POST -H "x-api-key: $INGEST_API_KEY" \
  "$API_URL/tasks/$TASK_ID/requeue")" || fail "requeue (request failed)"
REQUEUE_STATE="$(echo "$REQUEUE_JSON" | json_query 'data.state ?? ""')"
if [ "$REQUEUE_STATE" != "QUEUED" ]; then
  fail "requeue (expected QUEUED, got: $REQUEUE_JSON)"
fi
pass "requeue -> QUEUED"

echo "==> Waiting for reprocessing to reach REVIEW"
TASK_STATE=""
DETAIL_JSON="{}"
for attempt in $(seq 1 30); do
  DETAIL_JSON="$(curl -fsS -H "x-api-key: $INGEST_API_KEY" "$API_URL/tasks/$TASK_ID")" || DETAIL_JSON='{}'
  TASK_STATE="$(echo "$DETAIL_JSON" | json_query 'data.task?.state ?? ""')"
  case "$TASK_STATE" in
    REVIEW | NEEDS_INPUT | FAILED) break ;;
  esac
  sleep 2
done
if [ "$TASK_STATE" != "REVIEW" ]; then
  echo "still-missing required questions:"
  echo "$DETAIL_JSON" | json_query '((data.resolution ?? {}).missing ?? []).filter((q) => q.required)'
  fail "task reaches REVIEW after requeue (state: ${TASK_STATE:-unknown})"
fi
pass "task reached REVIEW after requeue"

echo "==> [6/7] Approve (DRY-RUN submit — no request is ever sent)"
APPROVE_JSON="$(curl -fsS -X POST -H "x-api-key: $INGEST_API_KEY" \
  "$API_URL/tasks/$TASK_ID/approve")" || fail "approve dry-run (request failed)"
echo "$APPROVE_JSON"
APPROVE_OK="$(echo "$APPROVE_JSON" | json_query 'data.dryRun === true && data.state === "REVIEW"')"
if [ "$APPROVE_OK" != "true" ]; then
  fail "approve dry-run (expected { state: REVIEW, dryRun: true }, got: $APPROVE_JSON)"
fi
pass "approve -> dry-run recorded, task back in REVIEW"

echo "==> [7/7] Verify the submit_dryrun api_call row"
DETAIL_JSON="$(curl -fsS -H "x-api-key: $INGEST_API_KEY" "$API_URL/tasks/$TASK_ID")" ||
  fail "fetch task detail"
FOUND="$(echo "$DETAIL_JSON" | RESUME_PATH="$RESUME_PATH" json_query \
  '(data.apiCalls ?? []).some((c) => c.phase === "submit_dryrun" && c.dryRun === true && JSON.stringify(c.requestBody ?? {}).includes(env.RESUME_PATH))')"
if [ "$FOUND" != "true" ]; then
  echo "$DETAIL_JSON" | json_query '(data.apiCalls ?? []).map((c) => ({ seq: c.seq, phase: c.phase, dryRun: c.dryRun }))'
  fail "submit_dryrun api_call with dryRun=true containing the resume storage path"
fi
pass "submit_dryrun api_call recorded with dryRun=true and resume storage path"

echo "E2E PASS (full permutation)"
exit 0
