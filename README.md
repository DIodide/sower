# sower

sower is a personal job-application automation system. It ingests job postings
(manually or from sources like Simplify), parses them into a normalized
`JobSpec` per platform (Greenhouse, Lever, Ashby, Workday), resolves
application questions truthfully from a local profile and answer bank, queues
work through Cloud Tasks (or an inline driver for local dev), and walks each
application through an explicit review-first state machine. It is built to
prepare applications, never to fire them off silently: every task stops for
human review, and real submission is hard-disabled by design.

## Architecture

```
            +----------+     +---------+     +-------------------+     +---------+
  URLs /    |  ingest  | --> |  queue  | --> | platform adapter  | --> | review  |
  sources   |  (API)   |     | (inline |     | (greenhouse/lever |     | (human  |
  --------> |  parse & |     |  or GCP |     |  /ashby/workday)  |     |  gate,  |
            |  dedupe  |     |  Tasks) |     |  resolve answers  |     |  dry-run|
            +----------+     +---------+     +-------------------+     +---------+
                 |                                    |                     |
                 v                                    v                     v
              Postgres  <---- application_tasks state machine ----> events log
```

State machine: `INGESTED -> PARSED -> QUEUED -> PREPARING -> (NEEDS_INPUT) ->
REVIEW -> (AWAITING_OTP) -> FILLING -> SUBMITTED -> CONFIRMED`, with `FAILED`
and `DUPLICATE` as terminal branches.

## Runbook

### Install

```sh
nvm use            # Node 22
corepack enable    # pnpm 10
pnpm install
cp .env.example .env   # fill in DATABASE_URL, INGEST_API_KEY
```

### Dev

```sh
pnpm dev           # runs @sower/api via tsx
```

### Test / lint / typecheck

```sh
pnpm test          # vitest across all packages and apps
pnpm lint          # biome
pnpm typecheck     # single root tsc --noEmit
```

### E2E local

Run Postgres locally, start the API with `QUEUE_DRIVER=inline`, then ingest a
job and watch it move through the state machine:

```sh
pnpm dev
curl -X POST localhost:8080/ingest \
  -H 'x-api-key: <INGEST_API_KEY>' \
  -H 'content-type: application/json' \
  -d '{"url": "https://boards.greenhouse.io/example/jobs/123"}'
```

With the inline driver the task is processed in-process; inspect
`application_tasks` and `events` to follow it to `REVIEW`.

### Deploy

Pushes to `main` trigger the `deploy` job in `.github/workflows/ci.yml`
(gated on the `check` and `gitleaks` jobs passing): GitHub OIDC ->
`google-github-actions/auth` -> Docker build/push to Artifact Registry
(`us-east1-docker.pkg.dev/<project>/sower/api`) -> `gcloud run deploy
sower-api` in `us-east1`.

## Guardrails (non-negotiable)

1. **Nothing ever submits a real application.** The Greenhouse `submit()`
   throws unless `SOWER_SUBMIT_ENABLED === 'true'`, and even then it only logs
   a dry-run payload and returns `{ dryRun: true }`.
2. **Truthfulness.** `resolveAnswers` never fabricates: an unmatched required
   question goes to `missing` and stops the task at `NEEDS_INPUT` — it is
   never guessed.
3. **No PII in the repo.** Only the fake sample profile (Jane Doe). No real
   names, emails, or keys anywhere; `.env` is gitignored and `.env.example`
   holds placeholders only.
4. **All mutating HTTP routes require `x-api-key === INGEST_API_KEY`**
   (Fastify preHandler; only `GET /healthz` is exempt).

### Accepted risks

- **GitHub Actions pinned by major tag, not SHA.** Third-party actions
  (`actions/checkout@v4`, `gitleaks/gitleaks-action@v2`, etc.) are pinned to
  major version tags rather than commit SHAs. Dependabot watches
  `github-actions` weekly and surfaces updates, so tag drift is monitored
  rather than SHA-frozen.
- **Cloud Run public invoker + app-level API key.** The `sower-api` Cloud Run
  service allows unauthenticated invocation at the platform layer; access
  control is enforced in-app via the `x-api-key` header (`INGEST_API_KEY`).
  Hardening this to Cloud Run OIDC/IAM-gated invocation is a TODO tracked in
  the sower-infra README.
