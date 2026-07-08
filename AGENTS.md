## Behavior
- Do NOT start implementing, designing or modifying code unless explicitly asked
- When user mentions an issue or topic, just summarize/discuss it - don't jump into action
- Wait for explicit instructions like "implement this", "fix this", "create this"

## Tool Guidelines
- When interacting with github, always reach for the `gh` cli first
- ALWAYS Use `rg` instead of `grep`
- ALWAYS Use `fd` instead of `find`. When doing so, do not search across the entire filesystem `/`.

## Environment
- RTK is running and compacting every bash command you run.
- Use `RTK_DISABLED=1` to bypass it and get the raw, unfiltered output if a command behaves unexpectedly or gets blocked. Do so ONlY for that isolated command and not the entire session.