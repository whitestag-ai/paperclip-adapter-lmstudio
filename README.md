# paperclip-adapter-lmstudio

[![CI](https://github.com/whitestag/paperclip-adapter-lmstudio/actions/workflows/ci.yml/badge.svg)](https://github.com/whitestag/paperclip-adapter-lmstudio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [Paperclip](https://github.com/paperclipai/paperclip) adapter for [LM Studio](https://lmstudio.ai/) — run Paperclip agents against OpenAI-compatible local LLMs with full tool-use support.

> German version: [README.de.md](README.de.md)

## What it does

Connects Paperclip agents to local LLMs served by LM Studio and implements a complete agent loop with tool use:

- **18 tools** spanning the Paperclip API, filesystem, and shell/git
- **OpenAI function calling** standard — works with any LM Studio model that supports function calling
- **Hybrid streaming:** tool iterations as request/response, final answer as token stream
- **Safety:** path-traversal guards, shell timeouts, run-ID audit trail
- **Primary + fallback endpoint** with health probes and sticky mid-call switching

## Requirements

- Node.js 18+
- LM Studio running with its API enabled (default: `http://localhost:1234`)
- At least one model loaded that supports function calling (e.g. Gemma, Qwen, Llama)

## Installation

```bash
git clone https://github.com/whitestag/paperclip-adapter-lmstudio.git
cd paperclip-adapter-lmstudio
pnpm install
pnpm build
```

Register in `~/.paperclip/adapter-plugins.json`:

```json
[
  {
    "packageName": "paperclip-adapter-lmstudio",
    "localPath": "/absolute/path/to/paperclip-adapter-lmstudio",
    "type": "lmstudio_local",
    "installedAt": "2026-04-22T00:00:00.000Z"
  }
]
```

Restart the Paperclip server.

## Configuration (per agent)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | text | `http://localhost:1234` | Primary LM Studio URL |
| `defaultModel` | select | — | Primary model |
| `fallbackUrl` | text | empty | Fallback LM Studio URL (e.g. Mac). Empty = no fallback |
| `fallbackModel` | text | empty | Fallback model name. Empty = same as `defaultModel` |
| `probeTimeoutMs` | number | `2000` | Timeout for the health probe before each heartbeat |
| `timeoutMs` | number | `120000` | Full call timeout |
| `streamingEnabled` | boolean | `true` | Token streaming |
| `maxIterations` | number | `25` | Max tool calls per heartbeat |

## Fallback endpoint

If a second LM Studio host is available (e.g. a Mac as backup for a Windows PC), configure it as fallback:

```json
{
  "url": "http://192.168.1.50:1234",
  "defaultModel": "gemma-4-31b-it",
  "fallbackUrl": "http://localhost:1234",
  "fallbackModel": "gemma-4-27b-it"
}
```

Per heartbeat:

1. Adapter calls `GET {primaryUrl}/v1/models` with `probeTimeoutMs`.
2. Probe OK → primary is used for the heartbeat.
3. Probe fails (connection refused / DNS / timeout) → fallback is probed and used. A meta-event in the run transcript records the switch.
4. Fallback also unreachable → run fails with `errorCode: "llm_unreachable"`.

If the adapter switches mid-heartbeat (e.g. primary crashes during a call), it stays sticky on the fallback until the heartbeat ends. The next heartbeat tries primary first again.

## Available tools

**Paperclip API (8):** `paperclip_get_identity`, `paperclip_get_inbox`, `paperclip_checkout_issue`, `paperclip_update_issue`, `paperclip_add_comment`, `paperclip_get_issue_context`, `paperclip_get_comments`, `paperclip_create_subtask`

**Filesystem (5):** `fs_read_file`, `fs_write_file`, `fs_list_directory`, `fs_glob`, `fs_grep`

**Shell & Git (5):** `shell_exec`, `git_status`, `git_diff`, `git_commit`, `git_log`

## Development

```bash
pnpm install
pnpm build     # tsc
pnpm test      # vitest run
pnpm dev       # tsc --watch
```

## Model recommendations

Tool use requires function calling. Tested models:

- **gemma-4-31b-it** — solid tool use, recommended for main agents
- **qwen/qwen3-14b** — fast, tool use works
- **qwen2.5-32b-instruct** — very good tool-use accuracy

Models without function-calling support tend to produce garbled output. Verify with a simple API call first.

## Troubleshooting

- **Agent stalls or doesn't respond:** check timeouts; for 70B+ models raise to 300s+
- **Tool calls ignored:** verify model supports function calling
- **Max iterations reached:** raise `maxIterations` or split the task
- **Fallback doesn't kick in:** check `fallbackUrl` reachability. Logs show `llm_unreachable` with probe reasons
- **Fallback detection too slow:** lower `probeTimeoutMs` (e.g. 1000ms)

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgments

Built by Walter Schoenenbroecher ([WHITESTAG.AI](https://whitestag.ai), <ws@whitestag.ai>) with AI pair-programming assistance from [Claude](https://www.anthropic.com/claude) (Anthropic).

## License

[MIT](LICENSE) © Walter Schoenenbroecher / WHITESTAG.AI
