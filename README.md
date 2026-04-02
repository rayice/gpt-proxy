# GPT Proxy

A proxy for **Codex OAuth** (ChatGPT Pro/Plus subscription) that exposes it as OpenAI and Anthropic-compatible API endpoints. This allows you to use your ChatGPT subscription with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

> [!WARNING]
> **Disclaimer:** This software is provided as-is, without warranty of any kind. Use of this proxy is entirely at your own risk. The authors accept no responsibility for any consequences arising from its use, including but not limited to account restrictions, data loss, or violations of third-party terms of service. You are solely responsible for ensuring your use complies with all applicable terms and policies.

> [!NOTE]
> This proxy uses the [OpenAI Codex API](https://chatgpt.com) via OAuth authentication. You need an active ChatGPT Pro or Plus subscription. All Codex models are included with your subscription at no additional per-token cost.

---

## Features

- **OpenAI & Anthropic Compatibility**: Exposes Codex as both OpenAI-compatible (`/v1/chat/completions`, `/v1/models`) and Anthropic-compatible (`/v1/messages`) API endpoints.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Codex models as its backend with a simple `--claude-code` flag.
- **Two OAuth Flows**: Supports both browser-based PKCE authentication and headless device code flow for non-interactive environments.
- **Prompt Caching**: Sends `prompt_cache_key` per session to enable server-side prompt caching on the Codex API.
- **Reasoning Effort Control**: Configurable per-model reasoning effort levels (`low`, `medium`, `high`, `xhigh`), selectable during interactive setup.
- **Usage Dashboard**: A web-based dashboard at `/usage-viewer` to monitor token usage per model, per session, and per day.
- **Automatic Token Refresh**: On-demand token refresh with mutex protection for concurrent requests.
- **Streaming Support**: Full SSE streaming support for both Anthropic and OpenAI formats, including thinking blocks, tool use, and reasoning.

## Available Models

All models are included with your ChatGPT Pro/Plus subscription:

| Model | Description |
|-------|-------------|
| `gpt-5.1-codex` | GPT 5.1 Codex |
| `gpt-5.1-codex-max` | GPT 5.1 Codex Max |
| `gpt-5.1-codex-mini` | GPT 5.1 Codex Mini (good for small/fast tasks) |
| `gpt-5.2` | GPT 5.2 |
| `gpt-5.2-codex` | GPT 5.2 Codex |
| `gpt-5.3-codex` | GPT 5.3 Codex |
| `gpt-5.4` | GPT 5.4 |
| `gpt-5.4-mini` | GPT 5.4 Mini |

## Prerequisites

- [Bun](https://bun.sh/) (>= 1.2.x)
- ChatGPT Pro or Plus subscription

## Installation

Clone the repository and install dependencies:

```sh
cd gpt-proxy
bun install
```

## Quick Start

### 1. Authenticate

**Browser-based (recommended):**

```sh
bun run src/main.ts auth
```

This opens your browser for OAuth authorization. Complete the sign-in flow and the token will be saved automatically.

**Headless (for servers/CI):**

```sh
bun run src/main.ts auth --headless
```

This displays a device code. Go to the URL shown, enter the code, and complete authorization.

### 2. Start the proxy

```sh
bun run src/main.ts start
```

The proxy starts on port 4141 by default. You'll see the available models and the usage viewer URL.

### 3. Use with Claude Code

```sh
bun run src/main.ts start --claude-code
```

This interactive setup will:
1. Prompt you to select a **main model** (e.g., `gpt-5.4`)
2. Prompt you to select a **small model** for lightweight tasks (e.g., `gpt-5.1-codex-mini`)
3. Prompt you to select **reasoning effort** levels for each model
4. Copy a launch command to your clipboard

Paste and run the clipboard command in a new terminal to start Claude Code connected to the proxy.

## Command Structure

- `start` — Start the proxy server. Requires prior authentication.
- `auth` — Run the Codex OAuth authentication flow without starting the server.

## Command Line Options

### Start Command

| Option | Description | Default | Alias |
|--------|-------------|---------|-------|
| `--port` | Port to listen on | `4141` | `-p` |
| `--verbose` | Enable verbose logging | `false` | `-v` |
| `--claude-code` | Interactive Claude Code setup (model + effort selection, clipboard command) | `false` | `-c` |
| `--show-token` | Show tokens on startup and refresh | `false` | — |

### Auth Command

| Option | Description | Default | Alias |
|--------|-------------|---------|-------|
| `--verbose` | Enable verbose logging | `false` | `-v` |
| `--show-token` | Show tokens on auth | `false` | — |
| `--headless` | Use headless device code flow instead of browser | `false` | — |

## API Endpoints

### OpenAI Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | `POST` | OpenAI Chat Completions API |
| `/v1/models` | `GET` | List available Codex models |

### Anthropic Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | `POST` | Anthropic Messages API (used by Claude Code) |

### Usage & Monitoring

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/usage` | `GET` | Token usage statistics (JSON) |
| `/usage-viewer` | `GET` | Web-based usage dashboard |

## Configuration

Configuration is stored at `~/.local/share/gpt-proxy/config.json`. A default config is created on first run.

```json
{
  "auth": {
    "apiKeys": []
  },
  "extraPrompts": {},
  "smallModel": "gpt-5.1-codex-mini",
  "modelReasoningEfforts": {
    "gpt-5.1-codex-mini": "low",
    "gpt-5.1-codex": "high",
    "gpt-5.1-codex-max": "xhigh",
    "gpt-5.2-codex": "high",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4": "xhigh",
    "gpt-5.4-mini": "xhigh"
  }
}
```

### Config Options

- **`modelReasoningEfforts`** — Per-model reasoning effort sent to the Codex Responses API. Allowed values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. If a model isn't listed, `high` is used. These can also be set interactively during `--claude-code` setup.
- **`smallModel`** — Model used for lightweight warmup requests from Claude Code. Defaults to `gpt-5.1-codex-mini`.
- **`extraPrompts`** — Map of `model -> prompt` appended to the system prompt. Use this to inject per-model instructions.
- **`auth.apiKeys`** — API keys for request authentication (planned for future use).

Edit this file and restart the proxy after changes.

## Using with Claude Code

### Interactive Setup (recommended)

```sh
bun run src/main.ts start --claude-code
```

Follow the prompts, then paste the generated command in a new terminal.

### Manual Configuration with `settings.json`

Create a `.claude/settings.json` file in your project root:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.4",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.1-codex-mini",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false"
  }
}
```

Then start the proxy in a separate terminal and launch Claude Code normally.

**Notes:**
- `ANTHROPIC_AUTH_TOKEN` can be any value (the proxy handles Codex auth internally).
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` is used by Claude Code for lightweight tasks (title generation, subagents, summarization).
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0` prevents billing info in system prompts that would invalidate prompt caching.
- `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` avoids unnecessary requests.

More Claude Code settings: [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

## Usage Dashboard

After starting the proxy, open the usage viewer URL shown in the console:

```
http://localhost:4141/usage-viewer
```

The dashboard shows:
- **Session usage** — Token totals since the proxy started
- **Daily usage** — Token totals for the current day (persisted across restarts)
- **Per-model breakdown** — Requests, input tokens, output tokens, and reasoning tokens for each model

The dashboard auto-refreshes every 30 seconds. Daily usage data is stored in `~/.local/share/gpt-proxy/usage/`.

## Data Storage

| Path | Contents |
|------|----------|
| `~/.local/share/gpt-proxy/auth.json` | OAuth tokens (access, refresh, expiry, account ID) |
| `~/.local/share/gpt-proxy/config.json` | Proxy configuration |
| `~/.local/share/gpt-proxy/usage/` | Daily usage statistics |
| `~/.local/share/gpt-proxy/logs/` | Request logs |

All auth files are created with `0o600` permissions (owner read/write only).

## How It Works

The proxy translates between client API formats and the Codex Responses API:

```
Claude Code / Anthropic client
    → POST /v1/messages (Anthropic format)
    → Translate to Responses API format
    → POST https://chatgpt.com/backend-api/codex/responses
    → Translate response back to Anthropic format
    ← Return to client

OpenAI client
    → POST /v1/chat/completions (OpenAI format)
    → Translate to Responses API format
    → POST https://chatgpt.com/backend-api/codex/responses
    → Translate response back to OpenAI format
    ← Return to client
```

Key translation mappings:
- Anthropic `tool_use` / `tool_result` ↔ Responses `function_call` / `function_call_output`
- Anthropic `thinking` blocks ↔ Responses `reasoning` with encrypted content
- Anthropic SSE events ↔ Responses SSE event types
- OpenAI `choices[].message` ↔ Responses `output[]` items
- `stop_reason` / `finish_reason` mapping across all three formats

## Example Usage

```sh
# Authenticate (browser)
bun run src/main.ts auth

# Authenticate (headless)
bun run src/main.ts auth --headless

# Start on default port
bun run src/main.ts start

# Start on custom port with verbose logging
bun run src/main.ts start --port 8080 --verbose

# Start with Claude Code interactive setup
bun run src/main.ts start --claude-code

# List models
curl http://localhost:4141/v1/models

# Send a chat completion
curl -X POST http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.1-codex",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Check usage
curl http://localhost:4141/v1/usage
```

## Development

```sh
# Run in development mode (auto-reload)
bun run dev

# Type check
bun run typecheck

# Build for production
bun run build
```

## Acknowledgments

This project is based on [copilot-api](https://github.com/caozhiyuan/copilot-api) by [@caozhiyuan](https://github.com/caozhiyuan). The proxy architecture, Anthropic/OpenAI translation layers, streaming infrastructure, and Claude Code integration patterns were adapted from his work. Thank you for building and open-sourcing the original proxy.

## License

MIT
