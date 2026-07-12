# @sower/dashboard

Minimal read-only dashboard for sower application tasks. Next.js 15 app
router, server components only (no client JS). Shows the latest 50
application tasks joined with their jobs, with a state badge per task.

There is no auth — run it locally or on a private network only.

## Run

```sh
pnpm --filter @sower/dashboard dev
```

with `DATABASE_URL` set (e.g. in your shell or a local `.env`):

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/sower pnpm --filter @sower/dashboard dev
```

Then open http://localhost:3000. If `DATABASE_URL` is not set, the page
renders a notice instead of querying.

## Build

```sh
pnpm --filter @sower/dashboard build
pnpm --filter @sower/dashboard start
```

`next.config.ts` uses `output: 'standalone'` for containerized deploys.
