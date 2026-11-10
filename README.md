# token-lens

A Claude Code mod that replaces the third-party Token Optimizer. It reports your token use, saves checkpoints across compaction, and tunes your setup to how you really use Claude. It has no network access, no background process and no hidden prompt text.

## Commands

All commands are `/tokens <option>`.

| Command | What it does |
|---|---|
| `/tokens [days]` | Token and cost report from your transcripts, by project, model and session. Default 30 days. |
| `/tokens audit` | Finds context waste: CLAUDE.md size, skill and agent descriptions, MCP servers, duplicates. Read only. |
| `/tokens plan` | Shows which plugins automatic tuning would turn off, and why. Changes nothing. |
| `/tokens auto [on\|off\|run\|status]` | Automatic tuning. On by default. `run` analyses and applies now. |
| `/tokens undo` | Turns back on every plugin token-lens turned off. |
| `/tokens checkpoint` | Saves a summary of this session now. |
| `/tokens checkpoints` | Lists this project's checkpoints. |
| `/tokens restore` | Shows the newest checkpoint for this project and adds it to the conversation. |
| `/tokens purge` | Deletes everything token-lens stored. |

## What it does by itself (default on, `/tokens auto off` stops all of it)

Every action is shown on screen (a log line, and a toast where noted) when it happens.

1. **Before a compaction:** saves a checkpoint, and, unless you typed your own `/compact` instructions, tells the summarizer to keep the active task, the files edited and the decisions. This is the only change to what the model is sent.
2. **After a compaction:** adds the checkpoint back to the conversation as a row labelled `[token-lens, added automatically after compaction...]`.
3. **Once a day, a few seconds after session start:** reads your transcripts (last 30 days) and learns which skills, commands, subagents and MCP servers you really use. A toast shows what it found.
4. **At most once a week:** turns off plugins in `~/.claude/settings.json` (`enabledPlugins` only) that are enabled, installed over 30 days ago, add only skills, commands, agents or MCP servers (never hooks or other behaviour), and left no trace in the last 30 days. At most 3 per run, and only when there are at least 15 sessions to judge from. The whole file is copied to the store first, the result is re-read, and the original is put back if it no longer parses. `/tokens undo` turns them back on (it only flips those plugin keys, so later edits to the file stay). A change takes effect on `/reload-plugins` or the next start.

It never edits CLAUDE.md, never touches `cleanupPeriodDays` or any other setting, and never removes an MCP server. CLAUDE.md and MCP duplicates are only reported by `/tokens audit`, because an automatic rewrite could lose instructions.

## Hooks (all of them)

| Hook | Matcher | What it does |
|---|---|---|
| `session.start` | none | Registers `/tokens`. Deletes expired checkpoints. Sets one timer (5 seconds, once) for the daily analysis. |
| `session.compact` | trigger `manual`, `auto` or `plugin` | Saves a checkpoint, adds summarizer instructions when you gave none, runs the compaction, then adds the checkpoint back. Never skips or blocks a compaction; a failing hook is passed through. |
| `command.run` | command `tokens` | Answers `/tokens`. |

The mod does not hook tool calls or tool results, and does not change the system prompt or your prompts. It never denies or rewrites anything.

## Files and data

**Files the mod writes:** only `~/.claude/settings.json`, and only the `enabledPlugins` flags described above, when automatic tuning applies a plan or you run `/tokens undo`. It writes no other file.

**Data stored**, in the engine's per-plugin store (`~/.claude/plugins/store/token-lens_*.json`):
- Checkpoints: project path, session id, time, the last three prompts, files edited, up to five decision-like lines. Text is cut to 300 characters and secrets are redacted (private keys, `sk-` and `ghp_` style keys, AWS keys, JWTs, bearer tokens, `key=`/`token=`/`password=` values, URL credentials, long hex strings). Kept 14 days and the newest 10 per project.
- Settings backups: the last 3 copies of `settings.json` taken before a change.
- Change log: the last 50 plugin ids turned off (this is what `/tokens undo` reads).
- Automatic tuning state: on or off, time of the last analysis and change.

**Uninstall:** run `/tokens undo` if you want the plugins back, then `/tokens purge`, uninstall the mod, and delete `~/.claude/plugins/store/token-lens_*.json` if it is still there. The mod cannot delete files itself. Note that `purge` also deletes the undo log.

**Files read (read only):** `~/.claude/projects/**/*.jsonl` (transcripts, for the report and the analysis); `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json` and each plugin's folder (for the plan); for the audit, CLAUDE.md files up to the project root, skill and agent files, `~/.claude.json` and `.mcp.json` files. The audit prints only server names, the host of a URL or the command name, never env values, arguments or tokens.

## Code that runs

`/tokens`, `/tokens audit`, `/tokens plan` and the daily analysis run `node hooks/scan.mjs` from this mod's own folder (`$.plugin.root`), once, then it exits. `scan.mjs` only reads. Nothing is run from any other folder, nothing is downloaded, and `npx` is never used. The mod uses the Node and TypeScript standard library only and has no dependencies.

## Security rules this mod keeps

1. No daemon, scheduled task, startup entry or editor extension. The only timer runs once, 5 seconds after session start.
2. Config writes are limited to `enabledPlugins` in `settings.json`, backed up, verified, logged and reversible. `cleanupPeriodDays` is never touched. No silent restore of settings.
3. Nothing is injected except the compaction instructions and the labelled checkpoint row above, both visible, both stopped by `/tokens auto off`.
4. No network calls. The report is plain text with no fonts or CDNs.
5. Only this mod's own code runs.
6. No tool call or result is blocked, denied or rewritten.

## Cost figures

Costs are estimates at first-party list prices, listed in `PRICES` in `hooks/scan.mjs` with the date they were checked (`PRICES_AS_OF`, printed in every report). A row names a model id (for example `opus-5-5`, `fable-5-1`, `haiku-5-5`) with its input, output and cache-read rate. Cache writes are priced from the input rate: 1.25 times for the 5 minute tier and 2 times for the 1 hour tier, using the split in the transcript (`cache_creation.ephemeral_1h_input_tokens`). A turn with no split counts as 5 minute. Haiku 5.5 has a higher rate above 100K prompt tokens. A model with no exact row uses its family row or the Sonnet rate, and the report lists it as estimated. Edit the table when prices change.

## Credits

- The feature ideas (usage report, checkpoints around compaction, setup audit) come from [Token Optimizer](https://github.com/alexgreensh/token-optimizer) by Alex Greenshpun (alexgreensh), released under PolyForm Noncommercial 1.0.0. token-lens is a separate rewrite. No code from Token Optimizer was copied or used.

## Tests

```
claude plugin validate .
claude plugin test .
node --test tests/*.test.mjs
```
