# Contributing

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/whitestag/paperclip-adapter-lmstudio.git
cd paperclip-adapter-lmstudio
pnpm install
pnpm build
pnpm test
```

## Development workflow

1. Fork the repository and create a branch from `main`.
2. Make your changes. Keep commits focused and use [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `refactor:`, `docs:`, `test:`).
3. Add or update tests where relevant. Aim to keep the test suite green (`pnpm test`).
4. Run `pnpm build` to ensure the TypeScript build is clean.
5. Open a pull request with a clear description of the change and motivation.

## Code style

- TypeScript strict mode.
- No runtime dependencies outside the Node.js standard library — keep the adapter lean.
- Match the existing structure: server-side code under `src/server/`, shared types at the top of each module.

## Testing

- Unit tests live next to the source under `tests/`.
- Integration tests that hit a real LM Studio instance are opt-in via environment variables (see `tests/integration.test.ts`).
- When adding a new tool handler, add unit tests covering both success and error paths.

## Reporting issues

Please include:

- Node.js version, pnpm version, OS
- LM Studio version and the loaded model
- Relevant adapter config (redact hostnames if sensitive)
- Full error/log output and a minimal reproduction if possible

For private/security reports, contact <ws@whitestag.ai>.

## Acknowledgments

This project is developed with AI pair-programming assistance from [Claude](https://www.anthropic.com/claude) (Anthropic). Commits produced with Claude's assistance include a `Co-Authored-By: Claude` trailer in the commit message — contributors are encouraged to follow the same convention when applicable.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
