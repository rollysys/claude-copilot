# claude-copilot

A local Anthropic-compatible HTTP proxy that lets [Claude Code](https://claude.com/claude-code) (and any other Anthropic-API client) talk to Claude models through your **GitHub Copilot Business** subscription. **No double subscription** — every call consumes the same Copilot Premium quota the official CLI does.

```sh
# Use it exactly like `claude` itself — claude-copilot is the default action.
$ claude-copilot --print "Hello"
Hello!

$ claude-copilot                                # interactive Claude Code
$ claude-copilot --model opus -p "..."          # any claude flag works
$ claude-copilot resume                         # any claude subcommand works
```

What happens when you run `claude-copilot`:
- A local proxy starts on a random port
- `claude` is spawned with `ANTHROPIC_BASE_URL` etc. set in **the child's environment only** — your shell stays clean
- When `claude` exits, the proxy stops and the exit code is propagated

To see claude-copilot's own help: `claude-copilot --help`.
To see claude's help: `claude-copilot run -- --help`.

If you need claude-copilot's own flags (`--log`, `--port`), use the explicit `run` form: `claude-copilot run --log -- --print "Hello"`.

---

## ⚠️ Disclaimer

This project is **not affiliated with, endorsed by, or sponsored by GitHub, Microsoft, or Anthropic**.

- "GitHub Copilot" is a trademark of GitHub, Inc.
- "Claude" is a trademark of Anthropic, PBC.

This tool reads the OAuth token that the official `@github/copilot` CLI stores after `copilot login`, then proxies Anthropic-style requests to the Copilot API on your behalf. It does **NOT** bypass authentication, billing, or quota — every request consumes the same Copilot Premium quota the official CLI does.

## ⚠️ API Stability

The Copilot endpoints we call (`/copilot_internal/user`, `/v1/messages`, `/models`) are **not formally documented public APIs**. GitHub may change them at any time. If that happens, file an issue and we'll catch up.

---

## How it works

```
   Claude Code  ─POST /v1/messages──▶  127.0.0.1:4242 (this proxy)
                                                │
                                  rewrites:
                                   • Bearer token from your copilot CLI
                                   • Copilot-Integration-Id: copilot-developer-cli
                                   • model id: claude-opus-4-7 → claude-opus-4.7
                                   • drops anthropic-beta tokens Copilot rejects
                                   • clamps output_config.effort to "medium"
                                                │
                                                ▼
                            api.business.githubcopilot.com/v1/messages
                                                │
                                                ▼
                                  Anthropic-format response
                                  (streams through verbatim)
```

The upstream natively returns Anthropic format, so the response body and SSE stream pass through untouched.

The proxy is also self-healing on a few known compatibility quirks:
- Drops a hardcoded list of `anthropic-beta` tokens Copilot doesn't accept (currently `advisor-tool-2026-03-01`, `context-1m-2025-08-07`).
- On HTTP 400 with `unsupported beta header(s): X`, it learns `X`, drops it from this request, and retries automatically — so future Anthropic betas work without a release.
- Strips `output_config.effort` for Haiku models (Copilot rejects effort on Haiku).
- Clamps `output_config.effort` to `medium` on Opus/Sonnet (Copilot's only supported value today).

## Install

Prerequisite: install and log in with the official Copilot CLI first.

```sh
npm i -g @github/copilot
copilot login
```

Then install this proxy:

```sh
npm i -g claude-copilot
```

Or from source:

```sh
git clone https://github.com/rollysys/claude-copilot.git
cd claude-copilot && npm install && npm run build && npm link
```

## Usage

### Default mode: just type `claude-copilot`

`claude-copilot` with no recognized subcommand passes everything through to `claude`:

```sh
claude-copilot                                  # interactive
claude-copilot --print "Hello"
claude-copilot --model opus -p "..."
claude-copilot resume                           # any claude subcommand
```

### Setting claude-copilot's own flags: `run`

When you need to pass `--log` or `--port` to claude-copilot itself, use the explicit `run` form. Anything before `--` is for us, anything after is for claude:

```sh
claude-copilot run --log -- --print "Compute 234*567"
claude-copilot run --port 4242 -- --model opus
```

### Other usage modes

#### Project-scoped settings.json (no shell pollution either)

Claude Code reads `.claude/settings.local.json` automatically:

```sh
mkdir -p .claude
claude-copilot settings --port 4242 > .claude/settings.local.json

# In another shell, start the daemon once:
claude-copilot serve --port 4242 &

# Now plain `claude` in this project picks up settings.local.json:
claude --print "Hello"
```

`.claude/settings.local.json` is gitignored by default — won't leak into commits.

#### Long-running daemon + explicit env vars (legacy/scriptable)

```sh
claude-copilot serve --port 4242 --log &
eval "$(claude-copilot env --port 4242)"
claude --print "Hello"
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY \
      ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
      ANTHROPIC_DEFAULT_HAIKU_MODEL
```

### All commands

| Command | What it does |
|---|---|
| `claude-copilot [args...]` *(default)* | Spawn `claude` with proxy auto-managed. Args go to claude. |
| `claude-copilot run [--log\|--port N] [-- args...]` | Same as above, but lets you set claude-copilot flags first. |
| `claude-copilot serve` | Start the local proxy as a long-running daemon. |
| `claude-copilot env [--port N]` | Shell `export` snippet for wiring Claude Code manually. |
| `claude-copilot settings [--port N]` | JSON snippet for `.claude/settings.local.json`. |
| `claude-copilot status` | Show login info, Copilot plan, upstream endpoint, integration id. |
| `claude-copilot test` | One-shot smoke test of the upstream `/v1/messages`. |

### Flags

| Flag | Default | Notes |
|---|---|---|
| `-p, --port <n>` | `4141` | Port to listen on. |
| `--host <ip>` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose to LAN. |
| `--log` | off | Log every forwarded request to stderr. |
| `-h, --help` | | Show help. |

### Environment variables

| Variable | Purpose |
|---|---|
| `GH_COPILOT_TOKEN` | Provide the token directly (skips keychain lookup). Required on Windows. |
| `COPILOT_INTEGRATION_ID` | Override the `Copilot-Integration-Id` header. |
| `COPILOT_DROP_BETAS` | Comma-separated extra `anthropic-beta` tokens to silently drop. |
| `CLAUDE_COPILOT_CLAUDE_PATH` | Path to the `claude` binary used by `run` (default: `claude` on PATH). |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Forward upstream fetch through a proxy. Honored automatically. |

## Token resolution

| Source | Tried when |
|---|---|
| `GH_COPILOT_TOKEN` env var | Always first |
| macOS Keychain (`security find-generic-password -s copilot-cli`) | macOS |
| Linux libsecret (`secret-tool search/lookup service copilot-cli`) | Linux, if `secret-tool` is on PATH (`apt install libsecret-tools`) |
| `~/.copilot/config.json` `copilot_tokens` field | Cross-platform fallback (set `storeTokenPlaintext` in that file before `copilot login`) |

## Library use

The token reader and HTTP server are exported for embedding:

```ts
import { startProxy, fetchCopilotUser, readCopilotToken } from 'claude-copilot';

const handle = await startProxy({ port: 0 /* random free port */ });
console.log(`Listening on http://${handle.host}:${handle.port}`);
// ... handle.stop() when done
```

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```

Layout:

```
src/
├── auth.ts        # token reader + Copilot user API + global proxy dispatcher
├── model-map.ts   # claude-opus-4-7  → claude-opus-4.7  (and date-stamp stripping)
├── server.ts      # HTTP proxy: rewrites headers + body, forwards /v1/messages
├── parse-args.ts  # pure CLI parser
└── cli.ts         # CLI entry
```

## License

MIT — see [LICENSE](./LICENSE).
