# claude-copilot

A non-interactive CLI helper for [GitHub Copilot](https://github.com/features/copilot). Reads the OAuth token already stored by the official [`@github/copilot`](https://www.npmjs.com/package/@github/copilot) CLI and adds shell-friendly flags (`-p`, `--bare`, `--json`, stdin pipes, streaming) so you can call Copilot from scripts and one-liners.

```sh
$ claude-copilot --bare -p "Write a one-liner to find files larger than 10MB"
find . -type f -size +10M

$ echo "explain this error" | claude-copilot --model claude-opus-4.6
…streaming response…

$ claude-copilot --json status | jq .plan
"business"
```

---

## ⚠️ Disclaimer

This project is **not affiliated with, endorsed by, or sponsored by GitHub, Microsoft, or Anthropic**.

- "GitHub Copilot" is a trademark of GitHub, Inc.
- "Claude" is a trademark of Anthropic, PBC.

This tool reads the OAuth token that the official `@github/copilot` CLI stores after `copilot login`, then calls the GitHub Copilot API on your behalf. It does **NOT** bypass authentication, billing, or quota — every request consumes the same Copilot quota that the official CLI does.

## ⚠️ API Stability

This tool relies on Copilot endpoints (`/copilot_internal/user`, `/chat/completions`, `/models`) that are **not formally documented public APIs**. GitHub may change them at any time, which would break this tool. If that happens, file an issue and we'll catch up.

---

## Install

Prerequisite: install and log in with the official CLI first.

```sh
npm i -g @github/copilot
copilot login
```

Then install this helper:

```sh
npm i -g claude-copilot
```

## Usage

### One-shot prompt

```sh
claude-copilot -p "your question"
claude-copilot -p "..." --bare              # answer body only
claude-copilot -p "..." --model claude-opus-4.6
claude-copilot -p "..." --no-stream
claude-copilot -p "..." --json              # full response object
echo "..." | claude-copilot                 # read from stdin
echo "..." | claude-copilot -p              # explicit -p with stdin
```

### Subcommands

| Command | Description |
|---|---|
| `claude-copilot status` | Login info, plan, and API endpoint |
| `claude-copilot models` | List available models for your plan |
| `claude-copilot usage`  | Quota usage (chat / completions / premium) |
| `claude-copilot test`   | End-to-end chat API smoke test |
| `claude-copilot login` / `logout` | Informational only — use `copilot login/logout` |

All subcommands accept `--json` for machine-readable output.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `-p, --print <text>` |  | The prompt. Omit to read from stdin. |
| `--bare` | off | Stdout = answer body only. Errors silently `exit 1/2`. |
| `--json` | off | Emit JSON. Implies `--no-stream`. |
| `-m, --model <id>` | `gpt-4.1` (overridable) | Model ID. Run `models` to see what's available. |
| `-s, --system <text>` |  | System prompt. |
| `--max-tokens <n>` | (none) | `max_tokens` cap. |
| `--no-stream` | streaming on | Disable streaming. |
| `-h, --help` |  | Show help. |

### Environment variables

| Variable | Purpose |
|---|---|
| `GH_COPILOT_TOKEN` | Provide the token directly (skips keychain lookup). Required on Linux/Windows. |
| `COPILOT_INTEGRATION_ID` | Override `Copilot-Integration-Id` header. |
| `COPILOT_DEFAULT_MODEL` | Override the default `--model`. |
| `HTTPS_PROXY` / `HTTP_PROXY` | Forward all fetch through proxy. Honored automatically. |

## Platform support

| Platform | Auto token lookup | Manual via `GH_COPILOT_TOKEN` |
|---|---|---|
| macOS    | ✅ via `security` CLI (Keychain) | ✅ |
| Linux    | ❌ | ✅ |
| Windows  | ❌ | ✅ |

On Linux/Windows, get your token from wherever the official CLI stored it (e.g. `secret-tool` on Linux with libsecret) and export it as `GH_COPILOT_TOKEN`.

## Library use

```ts
import {
  readCopilotToken,
  fetchCopilotUser,
  getChatHeaders,
  listModels,
} from 'claude-copilot';

const token = readCopilotToken();
const user = await fetchCopilotUser(token);
const models = await listModels(token, user.endpoints.api);
```

## Development

```sh
npm i
npm run build
npm test
```

The repo is laid out as:

```
src/
├── auth.ts        # token reader + API helpers
├── parse-args.ts  # pure CLI parser (heavily tested)
├── sse.ts         # OpenAI-style SSE chunk parser
└── cli.ts         # CLI entry; ties it together
```

## License

MIT — see [LICENSE](./LICENSE).
