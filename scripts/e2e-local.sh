#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_URL="http://localhost:8080"
export DATABASE_URL="postgres://postgres:sower@localhost:5432/sower"
export INGEST_API_KEY="dev-key"
export QUEUE_DRIVER="inline"

# Point at the fake sample profile wherever it lives.
if [ -f "$ROOT_DIR/config/profile.sample.yaml" ]; then
  export PROFILE_PATH="$ROOT_DIR/config/profile.sample.yaml"
elif [ -f "$ROOT_DIR/apps/api/config/profile.sample.yaml" ]; then
  export PROFILE_PATH="$ROOT_DIR/apps/api/config/profile.sample.yaml"
fi

echo "==> Starting postgres via docker compose"
docker compose up -d postgres

echo "==> Waiting for postgres to become healthy"
for attempt in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U postgres -d sower >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "postgres did not become healthy in time"
    echo "E2E FAIL"
    exit 1
  fi
  sleep 1
done

echo "==> Running database migrations"
pnpm --filter @sower/db migrate

echo "==> Starting API"
pnpm --filter @sower/api start &
API_PID=$!
cleanup() {
  kill "$API_PID" >/dev/null 2>&1 || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Waiting for API healthz"
for attempt in $(seq 1 60); do
  if curl -fsS "$API_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "API did not become healthy in time"
    echo "E2E FAIL"
    exit 1
  fi
  sleep 1
done

echo "==> Polling the Simplify source"
curl -fsS -X POST -H "x-api-key: $INGEST_API_KEY" "$API_URL/sources/simplify/poll"
echo

echo "==> Waiting for the inline queue to process tasks"
sleep 5

echo "==> Fetching tasks"
TASKS_JSON="$(curl -fsS -H "x-api-key: $INGEST_API_KEY" "$API_URL/tasks")"

if command -v jq >/dev/null 2>&1; then
  echo "$TASKS_JSON" | jq .
  MATCHED="$(echo "$TASKS_JSON" | jq '[.tasks[] | select(.state == "REVIEW" or .state == "NEEDS_INPUT")] | length')"
else
  MATCHED="$(echo "$TASKS_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(raw);
      const tasks = Array.isArray(parsed) ? parsed : (parsed.tasks ?? []);
      console.error(JSON.stringify(parsed, null, 2));
      const matched = tasks.filter(
        (t) => t.state === "REVIEW" || t.state === "NEEDS_INPUT",
      );
      console.log(matched.length);
    });
  ')"
fi

if [ "${MATCHED:-0}" -ge 1 ]; then
  echo "E2E PASS (${MATCHED} task(s) reached REVIEW or NEEDS_INPUT)"
  exit 0
fi

echo "E2E FAIL (no task reached REVIEW or NEEDS_INPUT)"
exit 1
