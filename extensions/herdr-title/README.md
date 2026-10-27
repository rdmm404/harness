# Pi session titles for Herdr

Self-contained Pi extension distributed by pi-sync. Requires Pi 1.4.0+ and
Herdr's built-in Pi integration (keep that integration installed).

The first agent turn in an unnamed interactive session generates a 3–7 word
title, without blocking the turn or changing the main agent model. Manual names
are preserved, including renames made while generation is running. Session
changes and shutdown cancel stale generation. Failures warn once per session;
there is no model discovery or fallback.

Edit `settings.json` beside `index.ts`:

```json
{"provider":"openai-codex","model":"gpt-6-luna","reasoningEffort":"none"}
```

Uses Pi's configured authentication; never put credentials in this directory.
Sends up to 6,000 characters of the first prompt to that model. `none` requests
the lowest reasoning level through Pi's model-specific mapping.

Inside Herdr, reports the session name as presentation metadata (`title`,
`$title`, `$kind`) for the current pane, refreshing every 15 seconds and after
name changes. Herdr still owns lifecycle state and resume identity. Title
generation also works outside Herdr; socket reporting becomes a no-op.

Publish with `/pisync push`; receive with `/pisync pull`, then `/reload`.
The socket helper deliberately uses `.ts`, not `.mjs`: Pi's extension loader
retains native ESM helpers across reloads, so `.mjs` changes can stay stale in
existing sessions even after `/reload`.
Tests: `node --test extensions/herdr-title/test/title.test.mjs` (Node 24+).
