# token-lens

A Claude Code mod that replaces the third-party Token Optimizer. It reports your token use, grades each session, folds long tool output, saves checkpoints across compaction, and tunes your setup to how you really use Claude. It has no network access and no background process, and every change it makes to what the model reads carries a label that names it and how to stop it.

## Install

From inside Claude Code:

```text
/plugin marketplace add RyanWeera/token-lens
/plugin install token-lens@token-lens
```

Then start a new session. To update later, run `/plugin marketplace update token-lens`.

## Commands

All commands are `/tokens <option>`. `/tokens help` prints the full list.

| Command | What it does |
|---|---|
| `/tokens [days]` | Token and cost report from your transcripts, by project, model and session. Default 30 days. |
| `/tokens quality` | This session's grade, S to F, with the score and what drags it down. |
| `/tokens report` | This session's context, part by part. |
| `/tokens conversation` | This session's cost, prompt by prompt. |
| `/tokens quick` | Today, this week and the top suggestion. |
| `/tokens trends [days]` | Cost and cache hit rate per day. |
| `/tokens drift` | This week against the week before. |
| `/tokens coach [days]` | Waste patterns (large file reads, retry churn, subagent cascades, an expensive model on light work, low grades) and what to do about them. |
| `/tokens route [days]` | Turns that a smaller model could have done. |
| `/tokens dashboard [days]` | Writes `~/.claude/token-lens/dashboard.html` and opens it. The page has no scripts and loads nothing from the network. |
| `/tokens memory` | Reviews this project's MEMORY.md files: long lines, missing and orphan files, duplicates. |
| `/tokens git` | What the uncommitted changes cost to read. |
| `/tokens doctor` | Checks the setup. |
| `/tokens audit` | Finds context waste: CLAUDE.md size, skill and agent descriptions, MCP servers, duplicates. Read only. |
| `/tokens plan` | Shows which plugins automatic tuning would turn off, and why. Changes nothing. |
| `/tokens auto [on\|off\|run\|status]` | Automatic tuning. On by default. `run` analyses and applies now. |
| `/tokens undo` | Turns back on every plugin token-lens turned off, with the same backup and check as the change itself. |
| `/tokens compress [bash\|search\|read] [on\|off]` | Tool output compression. On by default. |
| `/tokens nudge [lean\|quality\|loop\|route\|all] [on\|off]` | Hints added to your prompts. Off by default. |
| `/tokens checkpoint` | Saves a summary of this session now. |
| `/tokens checkpoints` | Lists this project's checkpoints and why each was saved. |
| `/tokens restore [n]` | Adds the newest (or the n-th) checkpoint for this project to the conversation. |
| `/tokens purge` | Deletes everything token-lens stored. |

## What it does by itself

Every action is shown where it happens: a label in the text the model reads, a log line, and a toast where noted.

1. **Tool output compression (default on, `/tokens compress off` stops it).** After a Bash, Grep or Glob call, long output is folded: colour codes and progress redraws go, a repeated line shows once with a count, and a label at the end says so. Output over 8,000 characters keeps about its first 2,400 and last 1,600 characters, with a label in the middle. A Glob or Grep list of more than 150 file names keeps the first 150. The full text is kept in the store, and the label names an id that the `expand` tool (`mcp__token-lens__expand`) takes to give it back. Errors, images and background tasks pass through unchanged.
2. **Repeat reads (part of compression, `/tokens compress read off` stops it).** When the same lines of a file are read again within 30 minutes in the same context, the Read is answered with a note instead of the file: an outline when nothing changed, or only the changed lines. The note names the id for the full text. A compaction clears this memory, so the first Read after it goes through whole. The memory of earlier reads is never written to disk, but the full text of a withheld repeat Read is archived in the store for 3 days, like folded output, so that `expand` can return it. `/tokens compress read off` stops this, and `/tokens purge` deletes the archive.
3. **Checkpoints:** before a compaction, before a subagent starts (at most every 10 minutes), after a failed or stopped turn, at session end, and every 20 minutes of work. A new session in a project with a checkpoint from another session in the last day shows a toast; nothing is added until you run `/tokens restore`.
4. **Around a compaction (`/tokens auto off` stops this):** unless you typed your own `/compact` instructions, it tells the summarizer to keep the active task, the files edited and the decisions. After the compaction it adds the checkpoint back as a row labelled `[token-lens, added automatically after compaction...]`. That row leaves out the files read and the tool errors, because they are text from outside the conversation; `/tokens restore` adds the full checkpoint.
5. **After each answer:** grades the session (S to F, from context fill, compactions, stale reads, files re-read in loops, large tool results, edits per tool call and long subagent reports) and writes `~/.claude/token-lens/quality-<session>.json`. The crab-progress band and project-link read this file.
6. **Nudges (default off, `/tokens nudge <name> on` turns one on).** A nudge is a labelled hint added beside your prompt, and a toast says so each time. `lean`: the context is over 25, 50 or 75% full. `quality`: the grade is low or dropped. `loop`: the request repeats an earlier one, the last 3 tool calls failed, or the same inline script ran 8 times. `route`: a small mechanical edit on an expensive model.
7. **Once a day, a few seconds after session start:** deletes quality files older than 14 days. Unless `/tokens auto off` is set, it then reads your transcripts (last 30 days) and learns which skills, commands, subagents and MCP servers you really use. A toast shows what it found.
8. **At most once a week (`/tokens auto off` stops it):** turns off plugins in `~/.claude/settings.json` (`enabledPlugins` only) that are enabled, installed over 30 days ago, add only skills, commands, agents or MCP servers (never hooks or other behaviour), and left no trace in the last 30 days. At most 3 per run, and only when there are at least 15 sessions to judge from. The `enabledPlugins` flags are copied to the store first, the result is re-read, and the original file is put back if it no longer parses. `/tokens undo` turns them back on (it only flips those plugin keys, so later edits to the file stay). A change takes effect on `/reload-plugins` or the next start.

It never edits CLAUDE.md, never touches `cleanupPeriodDays` or any other setting, and never removes an MCP server. CLAUDE.md and MCP duplicates are only reported by `/tokens audit`, because an automatic rewrite could lose instructions.

## Hooks (all of them)

| Hook | Matcher | What it does |
|---|---|---|
| `session.start` | none | Registers `/tokens` and the `expand` tool. Deletes expired checkpoints, archives and session records. Sets one timer (5 seconds, once) for the daily clean-up and analysis. |
| `session.compact` | trigger `manual`, `auto` or `plugin` | Saves a checkpoint, adds summarizer instructions when you gave none, runs the compaction, then adds the checkpoint back. Never skips or blocks a compaction; a failing hook is passed through. |
| `turn.complete` | none | After an answer of the main conversation: grade, a checkpoint when one is due, the quality file. |
| `agent.spawn` | none | A checkpoint before a subagent starts. Never holds or changes the spawn. |
| `session.end` | none | A last checkpoint when the session did work since the last one. |
| `prompt.submit` | none | Adds the nudges you turned on, as labelled context beside the prompt. Your prompt text is not changed. |
| `tool.call` | tool `Bash`, `Grep`, `Glob` | Folds the result as described above. The call itself runs unchanged. |
| `tool.call` | tool `Read` | Answers a repeat Read of unchanged or slightly changed lines with a note. |
| `tool.call` | tool `mcp__token-lens__expand` | Returns archived full output by id. |
| `command.run` | command `tokens` | Answers `/tokens`. |

The mod does not change the system prompt and does not block any tool call other than the repeat Read described above.

## Files and data

**Files the mod writes**, all inside `~/.claude/` (or `CLAUDE_CONFIG_DIR`):
- `token-lens/quality-<session>.json`: the session's grade, score parts, context fill, compactions, checkpoint time and tokens saved. Rewritten after each answer, deleted after 14 days.
- `token-lens/dashboard.html`: only when you run `/tokens dashboard`.
- `settings.json`: only the `enabledPlugins` flags described above, when automatic tuning applies a plan or you run `/tokens undo`.

**Data stored**, in the engine's per-plugin store (`~/.claude/plugins/store/token-lens_*.json`):
- Checkpoints: project path, session id, time, why it was saved, the last three prompts, files edited, up to five decision-like lines, the active mode, the last files read and the last errors. Text is cut to 300 characters (200 for paths and decisions) and secrets are redacted (private keys, `sk-` and `ghp_` style keys, AWS keys, JWTs, bearer tokens, `key=`/`token=`/`password=` values, URL credentials, long hex strings). Kept 14 days and the newest 10 per project.
- Archived full tool output: the newest 30, kept 3 days, each cut to 300,000 characters. This is what `expand` returns. It holds whatever the tool printed, and the file text of each withheld repeat Read, with no redaction. `/tokens purge` removes it.
- Per-session records: grade, compaction count, checkpoint times and nudge cool-downs. Kept 14 days.
- Tokens saved by compression, per day (30 days) and per session (the last 50).
- Settings: compression and nudge switches.
- Settings backups: the last 3 copies of the `enabledPlugins` flags (not the rest of `settings.json`, which can hold secrets), taken before each change or undo.
- Change log: the last 50 plugin ids turned off, each with the settings file it was in (this is what `/tokens undo` reads).
- Automatic tuning state: on or off, time of the last analysis, change and clean-up.

**Uninstall:** run `/tokens undo` if you want the plugins back, then `/tokens purge`, uninstall the mod, and delete `~/.claude/token-lens/` and `~/.claude/plugins/store/token-lens_*.json`. Note that `purge` also deletes the undo log.

**Files read (read only):** `~/.claude/projects/**/*.jsonl` (transcripts, for the reports and the analysis); `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json` and each plugin's folder (for the plan); for the audit, CLAUDE.md files up to the project root, skill and agent files, `~/.claude.json` and `.mcp.json` files; for `/tokens memory`, the project's memory folder; for `/tokens git`, the output of `git status` and `git diff HEAD` (run with repository hooks, fsmonitor, external diff, text conversion and submodules turned off, and not run at all when the repository's own config sets git filter commands). The audit prints only server names, the host of a URL or the command name, never env values, arguments or tokens.

## Code that runs

The reports, the audit, the plan, the dashboard and the daily analysis run `node hooks/scan.mjs` from this mod's own folder (`$.plugin.root`), once, then it exits. It runs with this mod's folder as its working directory. `scan.mjs` reads only, except that it writes `dashboard.html` and deletes quality files older than 14 days, both inside `~/.claude/token-lens/`. It skips symlinks and files over 1 MB in the audit, and strips control and bidirectional text characters from what it prints. Besides `node`, it starts `git` for `/tokens git` and the system opener (`explorer.exe`, `open` or `xdg-open`) for the dashboard. Nothing is run from any other folder, nothing is downloaded, and `npx` is never used. The mod uses the Node and TypeScript standard library only and has no dependencies.

## Security rules this mod keeps

1. No daemon, scheduled task, startup entry or editor extension. The only timer runs once, 5 seconds after session start.
2. Config writes are limited to `enabledPlugins` in `settings.json`, backed up, verified, logged and reversible. `cleanupPeriodDays` is never touched. No silent restore of settings.
3. Everything added to or changed in what the model reads is labelled with what did it and the `/tokens` command that stops it: folded output, repeat-read notes, nudges, compaction instructions and the checkpoint row.
4. No network calls. The report and the dashboard are plain text and HTML with no scripts, fonts or CDNs.
5. Only this mod's own code runs, plus `git` and the system file opener named above.
6. A tool call is never blocked, except the repeat Read above, which says why and how to get the full text.

## Cost figures

Costs are estimates at first-party list prices, listed in `PRICES` in `hooks/scan.mjs` with the date they were checked (`PRICES_AS_OF`, printed in every report). A row names a model id (for example `opus-5-5`, `fable-5-1`, `haiku-5-5`) with its input, output and cache-read rate. Cache writes are priced from the input rate: 1.25 times for the 5 minute tier and 2 times for the 1 hour tier, using the split in the transcript (`cache_creation.ephemeral_1h_input_tokens`). A turn with no split counts as 5 minute. Haiku 5.5 has a higher rate above 100K prompt tokens. A model with no exact row uses its family row or the Sonnet rate, and the report lists it as estimated. Edit the table when prices change.

## Credits

- The feature ideas (usage report, session grade, output compression, nudges, checkpoints around compaction, setup audit, dashboard) come from [Token Optimizer](https://github.com/alexgreensh/token-optimizer) by Alex Greenshpun (alexgreensh), released under PolyForm Noncommercial 1.0.0. token-lens is a separate rewrite. No code from Token Optimizer was copied or used.

## Tests

```
claude plugin validate .
claude plugin test .
node --test tests/*.test.mjs
```
