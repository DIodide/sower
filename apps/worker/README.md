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
