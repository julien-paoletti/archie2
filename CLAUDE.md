# Archie

A browser architecture-diagram editor. Plain ES modules, no build step, no runtime dependencies. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing the engine, editor or renderer, and [README.md](README.md) for what the app does.

## Commands

```sh
npm start                                  # http://localhost:5173
npm test                                   # node --test, engine and editor (no browser)
npm run shot -- tools/shots/sample.mjs     # screenshots into .shots/ (add `dark` for the dark theme)
```

`npm run shot` serves the app itself on a spare port and drives the installed Chrome (or Edge) through playwright-core. To check something new, write a case next to `tools/shots/sample.mjs`. The header of `tools/shot.mjs` describes the case format. Cases script the app through `window.archie` (`{ editor, renderer, app }`), and the runner prints page errors. Keep throwaway cases out of the repo (the scratchpad is fine). Commit one only when it's worth rerunning.

## Working on it

- **Check visual changes by eye:** take a screenshot in both the light and dark themes, then read the PNGs. Tests don't cover the renderer or the UI.
- **Commit each feature once it is done and verified,** with a message in the style of `git log` (imperative, plain English, no prefixes). Ask before pushing.
- **Keep the README in step:** when you add a user-visible feature, add or adjust its line in the README Highlights. If the design changed, update ARCHITECTURE.md too.
- **Priorities:** few clicks, sensible defaults and a polished look. Prefer a smart default over a new setting.

## Code rules

- **Layers:** `engine/` and `editor/` never touch the DOM, so they run under `node --test`. `render/` draws, and `ui/` is the DOM chrome. Domain knowledge (element kinds, link kinds, icons) lives only in `domain/`. Engine code reads it through the schema.
- **Changing a document:** every change goes through `doc.transact(label, fn)` so that undo, redo and patches work. A whole gesture is one undo step. While `doc.locked` is set (view-only or presenting), changes are refused unless `{ force: true }` is passed.
- **Input from outside** (files, share links, the clipboard, storage) goes through `sanitizeDiagram` in `engine/schema.js`. A new `data` or `style` field must be added to the field specs there, otherwise it is dropped on load.
- **Commands** are registered in `editor/commands.js`. Menus, the palette and the help sheet are built from that registry.
- **Content Security Policy:** `index.html` sets a strict CSP, so there are no inline scripts or styles, no `eval`, and nothing loaded from other origins except Google Fonts.
- **Style:** match the surrounding code. Use private `#fields`, short comments that explain why, and dense but readable lines. Tests live in `test/*.test.mjs` and read as sentences.
- **Shell edits on Windows:** avoid `node -e` with regexes or escapes, which have corrupted files before. Use the Edit tool, or a script file.
