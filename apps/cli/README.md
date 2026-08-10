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

```
sower tasks [--state a,b] [--limit n]     all tasks, every state incl. archive
sower task <id>                           full detail: questions (incl. saved
                                          answers), followups, jobNotes, timeline
sower questions <taskId>                  just the questions array
sower notes <taskId>                      the task's job-notes
sower notes add <taskId> --body <text> [--question <qid>]
sower notes rm <taskId> <noteId>
sower followups [<taskId>]                all open followups, or one task's
sower followup <id>                       followup detail
sower followup <id> --transition TRIAGE|SCHEDULE|COMPLETE_STEP|RESOLVE|DISMISS|REOPEN
sower mark-applied <taskId> [--note t]
sower discard <taskId> [--note t]
sower export [--state a,b] [--out f.json] every task in full detail
sower --help                              this reference
```

Output is compact JSON on stdout (`--pretty` for tables); errors are
one-line JSON on stderr.
