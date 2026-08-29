Sower is a personal task automation system. It ingests tasks in the form of links
(manually or from sources like Simplify), parses them into a normalized per platform spec (Google Forms, Greenhouse, Lever, Ashby, Workday), resolves
application questions truthfully from a local profile and answer bank, queues
work through Cloud Tasks, and walks each application through an explicit 
review-first state machine. It is built to prepare applications, never to fire
them off silently: every task stops for human review.

This repo is dependent on the following sibling repositories:
- DIodide/opentab (Turns a Mac-Mini into a residential proxy + CDP browser farm over Tailscale)
- DIodide/sower-infra (Terraform infrastructure for deployment to GCP)
- DIodide/information (private repository containing answers // profile information

## Architecture

The motivation for this architecture is that tasks though ill-defined in general, must pass through some form of deterministic finite automata to provide the structure needed foran application to be able to reason about the task lifecycle.

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


