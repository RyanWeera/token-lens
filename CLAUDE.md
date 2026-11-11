# token-lens

Local Claude Code mod: token and cost reports, session grade, tool output compression, opt-in nudges, checkpoints across compaction, setup audit. Replaces the rejected third-party token-optimizer.

@DIRECTORY_MAP.md

## Commands
- Validate: `claude plugin validate .`
- Test: `claude plugin test .` (file: `tests/register.test.ts`) and `node --test tests/*.test.mjs`
- Try the scanner: `node hooks/scan.mjs usage 7` and `node hooks/scan.mjs audit <cwd>`

## Conventions
- Standard library only. Ask before adding a dependency.
- The only config write allowed is `enabledPlugins` in settings.json (backup, verify, log, `/tokens undo`). Never CLAUDE.md, never `cleanupPeriodDays`. No network.
- Anything that changes what the model reads (folded output, repeat-read notes, nudges) carries a `[token-lens...]` label naming the `/tokens` switch that stops it. Nudges stay off by default.
- Other files go only in `~/.claude/token-lens/` (quality files, dashboard). crab-progress and project-link read `quality-<sid>.json`: keep its field names.
- Keep README.md in step with the hooks and stored data.

## Gotchas
- `$.fs` has no delete, so checkpoints, backups, archives and the change log live in `$.store` (purge works). Old quality files are deleted by `scan.mjs prune`.
- `scan.mjs` reads only, except `dashboard` and `prune` inside `~/.claude/token-lens/`. It prints a plan, and `register.ts` applies it.
- A mod module has no Node: file scanning is `hooks/scan.mjs`, run through `$.process.run` from `$.plugin.root`.
- Pure helpers (`checkpoint.ts`, `quality.ts`, `compress.ts`, `nudges.ts`) hold no `$`; a function taking `$` must stay in `register.ts`.
- In tests, the engine writes `$.fs.write` paths in Windows form (`C:\c\...`): find a written file by regex. A test hook on one event may be registered only once per test.
- Python heredocs and the Write tool can turn a backslash-n or a double backslash inside JS strings into a real newline or a single backslash. Check escapes after such an edit, or use `String.fromCharCode(10)`.
- skillspector flags the fake `.mcp.json` fixture in `tests/scan.test.mjs` (AS2); the audit really does read MCP config, read only.
