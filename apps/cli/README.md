# @sower/cli

`sower` — a non-interactive CLI over the sower api, built for agents: plain
args in, JSON out, no prompts, no TTY assumptions, meaningful exit codes
(0 ok · 1 error · 2 not found · 3 not configured).

## Install

`pnpm install` at the repo root links the workspace bin. To put `sower` on
your PATH, drop a shim at `~/.local/bin/sower`:

```sh
#!/bin/sh
exec /path/to/repo/node_modules/.bin/tsx /path/to/repo/apps/cli/src/main.ts "$@"
```

(`chmod +x ~/.local/bin/sower`. Inside the repo, `pnpm --filter @sower/cli
start -- <command>` works too.)

## Auth

Env wins: `SOWER_API_KEY` / `SOWER_API_BASE`. Otherwise:

```sh
sower auth set --token <token> --base https://sower-api-....run.app
```

writes `~/.config/sower/config.json` (chmod 600) and prints `ok`. The token
is never echoed anywhere.

## Commands

This is `sower --help`, verbatim (a test keeps the two identical):

```text
sower — non-interactive CLI over the sower api (JSON out)

usage: sower <command> [args] [--pretty]

auth
  auth set --token <t> [--base <url>]  save credentials (chmod 600); prints "ok"

read
  tasks [--state a,b] [--search <text>] [--limit n]
                                       all tasks, EVERY state incl. archive
                                       (states: INGESTED PARSED QUEUED PREPARING
                                       NEEDS_INPUT REVIEW AWAITING_OTP FILLING
                                       SUBMITTED CONFIRMED FAILED DUPLICATE DISCARDED)
  task <id>                            full detail: questions (incl. saved answers),
                                       followups, jobNotes, timeline
  description <taskId>                 {description} — the job description markdown
                                       (--pretty prints it raw, in full)
  questions <taskId>                   just the task's questions array
  answers <taskId>                     every question, compact: id, label, type,
                                       required, status, value, saved
  answer <taskId> <questionId>         one question, same compact shape
  notes <taskId>                       the task's job-notes
  followups [<taskId>]                 all open followups, or one task's followups
  followup <id>                        followup detail
  export [--state a,b] [--out f.json]  every task in full detail (file or stdout)

write
  answer set <taskId> <questionId> --value <v> [--value <v2>…] [--global]
                                       save an answer to the bank: repeated --value =
                                       multiselect; select values are option values;
                                       file questions take a document id; text answers
                                       are saved for this company unless --global.
                                       Re-resolves and reports what is still missing;
                                       adapter tasks apply it on the next run (requeue)
  task edit <id> [--notes <t> | --clear-notes] [--priority=-1|0|1|2]
                 [--due YYYY-MM-DD | --clear-due]
  resolve <taskId>                     re-run answer resolution in place (discovered specs)
  requeue <taskId>                     re-process a NEEDS_INPUT / FAILED task
  restore <taskId>                     bring a DISCARDED task back (NEEDS_INPUT)
  unmark-applied <taskId>              undo an out-of-band mark-applied
  reingest <taskId>                    reset the task in place and re-run ingestion
  mark-applied <taskId> [--note <t>]
  discard <taskId> [--note <t>]
  ingest <url> [--source <s>]          ingest one job url (source defaults to "cli")
  ingest --paste <text>                ingest every url found in a text blob
  ingest --manual --company <c> --title <t> [--notes <t>] [--priority=n]
                                       record a job with no url
  notes add <taskId> --body <text> [--question <qid>]
  notes edit <taskId> <noteId> [--body <text>] [--question <qid> | --general]
  notes rm <taskId> <noteId>
  followup add <taskId> --kind <k> --title <t> [--url <u>] [--due YYYY-MM-DD] [--notes <t>]
                                       (kinds: assessment interview recruiter offer
                                       rejection other)
  followup <id> --edit [--title <t>] [--url <u>] [--due YYYY-MM-DD] [--notes <t>]
  followup <id> --transition TRIAGE|SCHEDULE|COMPLETE_STEP|RESOLVE|DISMISS|REOPEN

config: env SOWER_API_KEY / SOWER_API_BASE beat ~/.config/sower/config.json
errors: one-line JSON on stderr · exit 0 ok, 1 error, 2 not found, 3 not configured
```

Output is compact JSON on stdout; errors are one-line JSON on stderr.

`--pretty` renders curated text for an 80–120 column terminal instead
(width from the tty, else `$COLUMNS`, else 100): `tasks` / `followups` are
tables whose least important columns drop first as the terminal narrows
(ids shortened to 8 characters — the JSON keeps full ids), `questions` /
`answers` print one block per question (`[✓]` resolved · `[~]` saved,
applies on next run · `[ ]` missing), `task` prints a sectioned summary,
and `description` prints the raw markdown.

### Setting answers

`sower answer set` writes to the same answer bank as the dashboard form,
through the same code (`@sower/answers` `saveAnswersToBank`): the question
must belong to the task, select/multiselect values must be option values
(see `sower questions`), a file question takes a document id, and a text
answer is saved for the task's company unless `--global`. The response
reports the saved count and a resolution summary (`resolved`, `missing`,
`requiredMissing`); `persisted: true` means the task's stored resolution was
refreshed in place (agent-discovered / unknown-platform jobs), `false`
means it is a preview — run `sower requeue <taskId>` to apply the answers.
