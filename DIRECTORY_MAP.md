# token-lens

- `.claude-plugin/` - plugin manifest
- `hooks/` - hooks module, checkpoint helpers, and the read-only scanner
- `tests/` - hook tests and scanner tests

## Where to change things
| Task | Folder |
|---|---|
| Commands or hooks | `hooks/` |
| Checkpoint contents, redaction, retention | `hooks/` |
| Report or audit output, price table | `hooks/` |
| Tests | `tests/` |
