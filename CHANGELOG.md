# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/whitestag/paperclip-adapter-lmstudio/releases/tag/v1.0.0
