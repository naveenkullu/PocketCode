# Contributing

Thanks for your interest in PocketCode. The project is in early development, and its active agent runtime is undergoing recovery; please avoid describing it as production-ready.

## Before opening an issue

- Search existing issues for duplicates.
- Include concise reproduction steps, expected behavior, and actual behavior.
- Include relevant command output with secrets and private repository data removed.
- Do not publish API keys, tokens, cookies, database files, or private source contents.

## Before opening a pull request

1. Keep changes focused and explain the user-visible or maintenance impact.
2. Do not include `.env`, databases, generated output, or runtime recovery backups.
3. Add or update tests for behavior changes when the relevant test setup allows it.
4. Run relevant checks and report exact commands and results. The test suite currently mixes Node's built-in runner and Vitest; see [Development](docs/DEVELOPMENT.md).
5. Update documentation when behavior, configuration, or setup instructions change.
6. Do not include real credentials or weaken existing authorization, workspace, or secret-handling controls.

## Development workflow

See [Development](docs/DEVELOPMENT.md) for prerequisites, local setup, scripts, and known validation limitations. Keep pull requests small enough to review and describe any unverified behavior explicitly.

## License

There is currently no `LICENSE` file in the repository. Do not assume that contributions or redistribution are covered by a particular license until the project owner adds one.
