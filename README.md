# paperclip-adapter-lmstudio

[![CI](https://github.com/whitestag-ai/paperclip-adapter-lmstudio/actions/workflows/ci.yml/badge.svg)](https://github.com/whitestag-ai/paperclip-adapter-lmstudio/actions/workflows/ci.yml)
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
- **Paperclip skills:** skills selected for the agent are injected into the system prompt (see below)
- **Runaway-heartbeat safety:** empty inboxes exit cleanly instead of burning tokens on improvised tool calls

## Requirements

- Node.js 18+
- LM Studio running with its API enabled (default: `http://localhost:1234`)
- At least one model loaded that supports function calling (e.g. Gemma, Qwen, Llama)

## Installation

```bash
git clone https://github.com/whitestag-ai/paperclip-adapter-lmstudio.git
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
| `maxToolResultChars` | number | `40000` | Cap for a single tool result (0 = off) |
| `maxPromptTokens` | number | `0` | Cap for the whole prompt; 0 = 80 % of the model's loaded window |

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

## Paperclip skills

Skills you assign to an agent in Paperclip are delivered to each run by the server (via the `paperclipRuntimeSkills` and `paperclipSkillSync` adapter-config keys). Because this adapter runs its own agent loop rather than a CLI that auto-discovers a skills directory, it surfaces them itself — using **progressive disclosure** so the base prompt stays small even for agents with many skills:

- The system prompt gets a compact **`## Available Skills`** index — each skill's **name + description** only (one line each), not the full body.
- A `skill_read` tool is offered to the model (only when the agent has skills). The model calls `skill_read` with a skill's name to pull that skill's full `SKILL.md` instructions on demand, right before acting on a matching task.

Resolution rules:

- Skills marked `required` in their `SKILL.md` frontmatter are always active.
- Skills explicitly selected for the agent are added on top (matched by key, runtime name, or slug).
- Both bundled (`paperclipai/paperclip/*`) and company-catalog (`local/*`) skills are supported.
- A skill whose `SKILL.md` cannot be read is skipped — it never aborts the run.

Each run with skills logs a `system` event listing the skills offered. Why progressive disclosure: a skill body averages ~1.8k tokens, so eagerly injecting 10–19 skills (common for fuller agents) would add 18–35k tokens to every prompt and crowd out the task on local models with tight context windows.

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
