# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[1.0.0]: https://github.com/whitestag-ai/paperclip-adapter-lmstudio/releases/tag/v1.0.0
