# .freecode — local state

FreeCode keeps its per-project state here. Only the two files below are meant
to be committed; everything else is created at runtime and gitignored.

| File | Committed? | Purpose |
| --- | --- | --- |
| `system-prompts.json` | **yes** | Editable agent prompts (global, jim, kai, alex). Edit and the running session reloads instantly. |
| `README.md` | **yes** | This file. |
| `config.json` | no | Agent, model, provider chain, optional API keys. Copy `config.example.json` to start. |
| `audit-log.jsonl` | no | KAI own-device authorisations and scan results (one JSON object per line). |
| `sessions/` | no | Saved CLI/desktop transcripts. |

Quick edits:

```bash
freecode                      # /preset kai You are KAI, ...
$EDITOR .freecode/system-prompts.json
```
