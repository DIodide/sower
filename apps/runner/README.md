# @sower/runner

Daemon for the "Fill in browser" feature. It polls the sower api for
requested fill jobs, opens the greenhouse application page in a Chrome tab
via [OpenTab](https://github.com/ibraheemamin/opentab) (localhost REST),
types every answered question into the real form over CDP, and reports a
live-view URL plus per-field outcomes back to the api. It **never** clicks
any button that would send the application — the human finishes in the
live view. File questions are reported as `skipped` for manual attachment.

## Requirements

- `opentab serve` running on this machine (default `http://127.0.0.1:9333`)
- a sower api token (`sower auth set`, or `SOWER_API_KEY`)
- Chrome installed (OpenTab launches and owns the instances)

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `SOWER_API_KEY` | token from `~/.config/sower/config.json` | api key (`x-api-key`) |
| `SOWER_API_BASE` | base from the same file, else `http://127.0.0.1:8080` | sower api base URL |
| `OPENTAB_BASE` | `http://127.0.0.1:9333` | OpenTab serve base URL |
| `OPENTAB_TOKEN` | contents of `${OPENTAB_HOME:-~/.opentab}/token` | OpenTab serve token |
| `POLL_SECONDS` | `15` | claim-poll interval |

## Run (dev)

```sh
pnpm --filter @sower/runner start
```

## Run under launchd (Mac mini)

Save as `~/Library/LaunchAgents/dev.ibraheemamin.sower-runner.plist`,
replacing `/path/to/sower` with the repo checkout and `/Users/you` with
your home directory. The repo's own `tsx` binary runs the daemon, so
`node` must be reachable through the `PATH` given below.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ibraheemamin.sower-runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/sower/node_modules/.bin/tsx</string>
    <string>/path/to/sower/apps/runner/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/sower/apps/runner</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SOWER_API_BASE</key>
    <string>https://your-sower-api.example</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/sower-runner.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/sower-runner.log</string>
</dict>
</plist>
```

Install and start:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ibraheemamin.sower-runner.plist
launchctl kickstart -k gui/$(id -u)/dev.ibraheemamin.sower-runner
```

Stop and remove:

```sh
launchctl bootout gui/$(id -u)/dev.ibraheemamin.sower-runner
```

Logs land in `~/Library/Logs/sower-runner.log`. Tokens are read from the
config files above, so none need to live in the plist.
