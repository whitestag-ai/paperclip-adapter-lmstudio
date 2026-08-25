# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [1.3.2] - 2026-08-25

### Fixed

- **The calibration arrived one call too late.** `calibrateFactor()` only
  learns after a response, and the first call of a run is system prompt plus
  task — prose, factor ~1.0. The JSON-heavy tool results arrive afterwards,
  were still estimated at `chars/4`, and blew the window before the next
  calibration could correct anything. Observed the morning of 25.08.: 68 budget
  events, **not a single trim**, and 36 overflows on `gemma4-31b-it` in one hour.

  The estimate is now density-aware by role: `tool` results and `tool_calls`
  arguments count at `chars/2`, everything else at `chars/4`. Measured against
  `gemma4-31b-it`: prose 4.18 chars/token, JSON 1.89, shell output 1.83 — so
  `2` is deliberately a little conservative, and `calibrateFactor()` still
  corrects whatever remains.

## [1.3.1] - 2026-08-25

### Fixed

- **The token estimate was optimistic where it mattered most.** `chars/4` holds
  for German prose (measured 4.18 chars/token against `gemma4-31b-it`) but
  underestimates JSON by 2.12x (1.89 chars/token) and shell output by 2.18x
  (1.83) — and tool results are almost never prose. A prompt capped at "78,643
  tokens" was really past 160,000, so `Context size has been exceeded` kept
  happening after 1.3.0 shipped: `gemma4-31b-it` went 99 (23.08.) -> 167
  (24.08.).

  The cap no longer guesses. `calibrateFactor()` derives a correction from
  `usage.prompt_tokens`, which LM Studio returns after every call anyway, and
  `trimMessages()` applies it. The factor keeps the worst ratio seen rather
  than averaging — a prose-heavy call must not undo the correction learned from
  a JSON-heavy one — and never drops below 1, because under-trimming is the
  dangerous direction while over-trimming only costs history.

- Budget events carried `type` instead of `kind`. The ui-parser keys on `kind`;
  without it the line fell through to `{ kind: "assistant", text: <raw JSON> }`
  and appeared in the transcript as if the agent had spoken JSON.

## [1.3.0] - 2026-08-23

### Added

- **Context budget.** The message history no longer grows unbounded. Two
  independent guards, both configurable:
  - `maxToolResultChars` (default `40000`) caps a *single* tool result before
    it enters the history. `shell_exec` could return up to 10 MB, `skill_read`
    whole skill bodies, `paperclip_get_issue_context` the full API response —
    all of it unbounded until now. The truncation is marked in the content so
    the model can tell it from a genuinely short result.
  - `maxPromptTokens` (default `0` = automatic) caps the *whole* prompt. On
    `0` the adapter reads the model's currently loaded window from
    `GET /api/v0/models/<id>` and budgets 80 % of it, so the cap follows the
    machine a model is placed on instead of a hard-wired number. Oldest
    assistant/tool exchanges are dropped first; the system prompt and the task
    always survive, and tool messages are only ever dropped together with the
    assistant message that called them (an orphan `tool_call_id` makes LM
    Studio reject the whole request with a 400).

  The window lookup is lazy — it only happens once the estimated prompt passes
  32k tokens, so an ordinary short heartbeat costs no extra HTTP call.

  Motivation: measured over one week, `Context size has been exceeded` killed
  220 calls on `google/gemma-4-12b`, 120 on `gemma4-31b-it` and 97 on
  `abiray/qwen3.6-35b-a3b`. Decisive: `gemma-4-31b-it-mlx` runs at 262144 —
  the model maximum — and still failed 33 times. A larger window does not fix
  this; the prompt has to get smaller.

## [1.2.0] - 2026-06-14

### Added

- **Dynamic model listing.** `listModels` accepts an optional `{ url }` so the
  Paperclip UI can enumerate the models served by the configured endpoint. The
  config schema is now fully static, with `meta.optionsFromUrlField` /
  `disabledWhenEmpty` driving the model picker.

### Fixed

- **Empty-inbox exit + runaway-heartbeat kill switch.** The system prompt now
  starts with `paperclip_get_inbox` and an explicit empty-inbox exit sentence,
  and the agent loop force-exits cleanly (`exitCode 0`) once an empty inbox is
  observed and no issue was checked out. Previously, small local models
  (qwen3, gemma, mistral-small) couldn't reconcile an empty inbox with the
  "MUST checkout an issue" prompt and improvised curl/filesystem calls, burning
  30k–100k tokens per no-work heartbeat and spamming the dashboard with failed
  runs. MCP-awareness and the post-run guard are preserved.

[1.2.0]: https://github.com/whitestag-ai/paperclip-adapter-lmstudio/releases/tag/v1.2.0

## [1.1.0] - 2026-06-14

### Added

- **Paperclip skill support with progressive disclosure.** Skills selected for an agent are read from the run's `paperclipRuntimeSkills` / `paperclipSkillSync` config. Previously the adapter ignored the skill payload entirely, so skills never reached the LLM. Now:
  - The system prompt gets a compact `## Available Skills` index (name + description per skill).
  - A `skill_read` tool (offered only when the agent has skills) loads a skill's full `SKILL.md` on demand, keeping the base prompt small for local models with tight context windows.
  - Required skills are always active; explicitly-desired skills (by key, runtime name, or slug) are unioned in. Both bundled (`paperclipai/paperclip/*`) and company-catalog (`local/*`) skills resolve. Unreadable skills are skipped without failing the run.
- **Skill capability reporting.** The adapter now exports `listSkills` / `syncSkills` (mode `ephemeral`) and `requiresMaterializedRuntimeSkills: false`, so the Paperclip UI reports the adapter as skill-capable and shows per-agent skill state (`configured` / `available` / `missing`) instead of `unsupported`.

## [1.0.0] - 2026-04-22

### Added

- Initial public release.
- OpenAI-compatible function-calling adapter for LM Studio with a complete Paperclip agent loop.
- 18 tools across the Paperclip API, filesystem, and shell/git.
- Primary/fallback LM Studio endpoints with health-probe and sticky mid-call switching.
- Typed `LlmClientError` classification (network / model / timeout / unknown).
- Hybrid streaming: tool iterations as request/response, final answer streamed.
- Path-traversal guards for filesystem tools, shell timeouts, run-ID audit trail.
- Unit and integration test suites (opt-in integration via `DPO_INTEGRATION=1` / live LM Studio).

[1.1.0]: https://github.com/whitestag-ai/paperclip-adapter-lmstudio/releases/tag/v1.1.0
[1.0.0]: https://github.com/whitestag-ai/paperclip-adapter-lmstudio/releases/tag/v1.0.0
