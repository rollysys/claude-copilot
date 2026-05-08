# claude-copilot

A local Anthropic-compatible HTTP proxy that lets [Claude Code](https://claude.com/claude-code) (and any other Anthropic-API client) talk to Claude models through your **GitHub Copilot Business** subscription.

```sh
$ claude-copilot serve --port 4242
claude-copilot proxy listening on http://127.0.0.1:4242
User:     you (business)
Upstream: https://api.business.githubcopilot.com

# In another shell:
$ eval "$(claude-copilot env --port 4242)"
$ claude --model opus --print "Hello"
Hello!
```

`claude` now sends every request to your local proxy, which forwards it to Copilot using the OAuth token already stored by the official `@github/copilot` CLI. **No double subscription** — every call consumes your normal Copilot Premium quota.

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

### Start the proxy

```sh
claude-copilot serve --port 4242 --log
```

`--log` prints one line per forwarded request to stderr.

### Point Claude Code at it

```sh
eval "$(claude-copilot env --port 4242)"
claude --model opus --print "Hello"
```

`claude-copilot env` prints `export ANTHROPIC_BASE_URL=...`, `ANTHROPIC_API_KEY=...`, and `ANTHROPIC_DEFAULT_*_MODEL=...` lines you can `eval`. Run `unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL` to revert.

### Other commands

| Command | What it does |
|---|---|
| `claude-copilot serve` *(default)* | Start the local proxy. |
| `claude-copilot env [--port N]` | Print shell exports to wire Claude Code to the proxy. |
| `claude-copilot status` | Show login info, Copilot plan, upstream endpoint, and integration id. |
| `claude-copilot test` | One-shot smoke test of the upstream `/v1/messages` (skips the proxy). |

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
