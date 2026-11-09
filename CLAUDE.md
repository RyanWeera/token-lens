# token-lens

Local Claude Code mod: token and cost report, checkpoints across compaction, setup audit. Replaces the rejected third-party token-optimizer.

@DIRECTORY_MAP.md

## Commands
- Validate: `claude plugin validate .`
- Test: `claude plugin test .` (file: `tests/register.test.ts`) and `node --test tests/*.test.mjs`
- Try the scanner: `node hooks/scan.mjs usage 7` and `node hooks/scan.mjs audit <cwd>`

## Conventions
- Standard library only. Ask before adding a dependency.
- The only config write allowed is `enabledPlugins` in settings.json (backup, verify, log, `/tokens undo`). Never CLAUDE.md, never `cleanupPeriodDays`. Never block, deny or rewrite a tool call or result. No network.
- Keep README.md in step with the hooks and stored data.

## Gotchas
- `$.fs` has no delete, so checkpoints, backups and the change log live in `$.store` (purge works). The only file the mod writes is settings.json.
- `scan.mjs` stays read only: it prints a plan, and `register.ts` applies it.
- A mod module has no Node: file scanning is `hooks/scan.mjs`, run through `$.process.run` from `$.plugin.root`.
- Pure helpers (`checkpoint.ts`) hold no `$`; a function taking `$` must stay in `register.ts`.
- skillspector flags the fake `.mcp.json` fixture in `tests/scan.test.mjs` (AS2); the audit really does read MCP config, read only.
