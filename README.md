# Delta Explorer

**An AI helper for learning anything**, on the desktop and in the browser. Bring your own model,
expand any text inline, look things up, chat, think on an infinite canvas of answers, and let it
remember how you learn.

This repository is a monorepo with npm workspaces:

| Path                               | What it is                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`apps/desktop`](apps/desktop)     | The Electron app: chat, canvas, and a screen-aware look-up popup on a global hotkey                             |
| [`apps/extension`](apps/extension) | The Firefox and Chrome extension: inline page expansions, a toolbar look-up, chat, and any web page as a canvas |
| [`packages/core`](packages/core)   | The TypeScript both apps run: canvas model and layout, rich text, conversations, prompts, context budget        |
| [`packages/ui`](packages/ui)       | The React UI both apps render: the canvas, markdown answers and inline expansions                               |

## Development

Requires Node.js 22+.

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build:extension
```

`npm run dev` starts the desktop app with hot reload. The extension builds into
`apps/extension/dist/firefox` and `apps/extension/dist/chrome`; load `dist/firefox/manifest.json`
from `about:debugging` in Firefox, or `dist/chrome/` with **Load unpacked** in Chrome
(`npm run dev:extension` rebuilds on every change, into `dist/dev/`; see the
[extension README](apps/extension/README.md)).

Before committing, run the full check: typecheck, lint, tests, formatting and the extension build.

```bash
npm run verify
```

See each app's README for features and packaging, and [`AGENTS.md`](AGENTS.md) for the architecture.

## License

MIT — see [LICENSE.md](LICENSE.md).
