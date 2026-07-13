# @sower/worker — browser-tier scaffold

Scaffold for the whitepaper's browser automation tiers. **No browser runs
today**: this package ships interfaces, pure helpers, and guardrails so the
tiers can land incrementally without ever enabling a live browser submit.

## The tier ladder

| Tier | What it is | Status |
| ---- | ---------- | ------ |
| **T0 — network** | Public ATS APIs only: `discover` + `dryRunSubmit` for **greenhouse / ashby / lever**. No browser. | **Done** — lives in `@sower/platforms`, runs inside `apps/api`. |
| **T1 — scripted** | Per-platform Playwright scripts fill known form layouts. | Deferred (this scaffold). |
| **T2 — script + LLM** | T1 scripts with an LLM fallback (Stagehand-style) for fields the script does not recognize. | Deferred. |
| **T3 — agent** | A browser agent handles arbitrary flows end to end. | Deferred. |

## What is here

- `src/browser-worker.ts` — the `BrowserWorker` contract
  (`fill(task): Promise<FillArtifacts>`) every tier will implement, plus
  `createBrowserWorker()`, whose `fill` logs
  `T1/T2/T3 browser tiers: scaffold only` and throws `NotImplementedError`.
  It performs zero I/O; tests assert `fetch` is never called.
- `src/har.ts` — HAR capture helpers (interface only): the exact
  `recordHar` options a tier must pass to `browser.newContext()`
  (`buildRecordHarOptions`), the plan for attaching a captured HAR to a
  task's `documents`/`api_calls` (`planHarAttachment`), and the deferred
  `HarAttacher` interface. The `playwright` import is **type-only** and
  erased at runtime.
- `src/main.ts` — runnable stub for `pnpm start`; prints the scaffold notice
  and exits.

## Where fill() sits in the task lifecycle

`REVIEW --APPROVED--> FILLING`: a browser tier acts on `FILLING` tasks
(`jobSpec` + `resolution` populated). It fills the form, captures evidence
(screenshots, redacted HAR, `ApiCallRecord`s), and **stops before any submit
action**, returning `FillArtifacts` whose `nextEvent` is `FILLED` (back to
`REVIEW` for human approval) or `NEED_OTP`. It never emits `SUBMIT_OK`.

## Guardrails

- **No real submission, ever.** `FillArtifacts.stoppedBeforeSubmit` is the
  literal type `true`. Submission remains `dryRunSubmit`-only behind the
  `SOWER_SUBMIT_ENABLED` guard in `@sower/platforms`; browser tiers do not
  get their own submit path.
- **Truthfulness.** Tiers type resolved answers (profile / bank / user /
  document) into forms verbatim — they never invent values.
- **No browser downloads.** `playwright` is a declared dependency, but
  pnpm 10 ignores dependency build scripts unless allowlisted
  (`pnpm.onlyBuiltDependencies` — not granted in this repo), so installing
  does **not** download browsers. If lifecycle scripts are ever enabled, set
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in CI. Do not run
  `npx playwright install` in CI.
- **No Playwright execution in tests.** Unit tests cover only pure helpers;
  the sole `playwright` reference in `src/` is a type-only import.
- **Secrets stay out of artifacts.** HARs are recorded with
  `content: 'omit'` (no response bodies); when the attach step lands,
  headers are redacted with the same rules as the `@sower/platforms`
  recorder before anything is persisted.

## Local capture agent (`pnpm agent`)

Workday is the one platform that needs a **headful, human-in-the-loop** browser
step — you solve the captcha and sign in on a residential IP. The cloud
dashboard can't open a browser you can see, so that one step runs here, on your
machine, driven by the dashboard through the cloud api.

`scripts/agent.ts` (→ `src/agent.ts`) is a small always-on daemon. It polls the
api for a pending capture request (created when you click **Start session
capture** on a parked Workday task), opens a Chrome window with the per-tenant
candidate credential pre-filled, waits while you complete sign-in / account
creation / email OTP **live**, captures the session, **verifies it from this
machine's IP** (`CalypsoClient.checkSession`), and reports it back. The api
vaults the session and re-enqueues the tenant's parked tasks. Everything
downstream (questionnaire read → REVIEW → Approve → calypso fill) runs in the
cloud over HTTP.

Footprint: it talks ONLY to the api (HTTPS + `x-api-key`) — no DB, no GCS. It
never submits.

Run it:

```sh
API_BASE_URL=https://sower-api-....run.app \
INGEST_API_KEY=<the ingest key> \
  pnpm --filter @sower/worker agent
```

Optional env: `SOWER_AGENT_NAME` (default `home-agent`),
`SOWER_RESIDENTIAL_PROXY` (`http://user:pass@host:port`), `SOWER_AGENT_POLL_MS`.

### Always-on (launchd)

Save as `~/Library/LaunchAgents/dev.sower.agent.plist`, edit the paths + env,
then `launchctl load ~/Library/LaunchAgents/dev.sower.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.sower.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/pnpm</string>
    <string>--filter</string><string>@sower/worker</string><string>agent</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/code/JobApplier/sower</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>API_BASE_URL</key><string>https://sower-api-....run.app</string>
    <key>INGEST_API_KEY</key><string>REPLACE_ME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/sower-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/sower-agent.err</string>
</dict>
</plist>
```

The agent heartbeats every cycle; the dashboard **Sessions** tab shows
"agent last seen" so a dead daemon is visible rather than silently never
servicing a Start click.
