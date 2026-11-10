# AGENTS.md

## Overview
Firefox MV3 extension, the browser companion to the Delta Explorer desktop app. Both live in one
monorepo: this is the `@delta/extension` workspace (`apps/extension`), the desktop app is
`apps/desktop`, and the pure logic they share is `@delta/core` (`packages/core`, TypeScript).
Its features mirror the desktop app's, including the canvas; the desktop look-up's screen OCR becomes
page text, and any web page can be opened as a canvas whose first card is the page. KaTeX is vendored
unmodified in `vendor/katex/`.

## Building and loading the extension
Firefox loads `dist/`, never the sources: the pages and the background import `@delta/core`, which
only a bundler can resolve.
1. From the repository root: `npm install`, then `npm run build:extension` (or
   `npm run dev:extension` to rebuild on every change).
2. Open `about:debugging#/runtime/this-firefox` and click **Load Temporary Add-on…**
3. Select `apps/extension/dist/manifest.json`

`scripts/build.mjs` bundles the four module entries (`background.js`, `popup/popup.js`,
`dashboard/js/app.js`, `canvas/canvas.jsx`, the one React page) with esbuild, unminified, plus
`canvas/canvas-ui.css` (the shared canvas styles and KaTeX's, fonts written to `assets/`). It copies
everything else that ships: manifest, HTML, CSS, icons, `vendor/`, and the classic scripts named by the
manifest's content scripts or loaded by a page without `type="module"`. A new module file needs nothing;
a new classic script must be referenced from the manifest or a page's HTML to be copied.

## Architecture

```
background.js (module)   →  message router, streaming host (Ports), context menu, commands, KB scheduler
content.js + src/content →  inline page bubbles, injected into all frames (classic scripts, shared scope)
popup/                   →  toolbar look-up (a ConversationView with role 'lookup')
dashboard/               →  Home, Chat, Canvas, Knowledge Base, Guide, Settings (hash routes, ES modules)
canvas/                  →  the canvas page (React, @delta/ui): over a web page, in a tab, or in the
                            dashboard's Canvas route
src/ui/                  →  page UI: ConversationView, api bridge, dom helpers, attachments, CSS, and
                            ui-host.js (the shared canvas's host: requests and Ports)
src/shared/              →  pure logic: prompts, models, conversation, rich-text, context-budget, markdown,
                            canvas, canvas-selection (re-exports of @delta/core)
src/background/
├── provider.js          →  OpenAI-compatible streaming client with a function-tool agent loop
├── config.js            →  model config (connections + roles) and settings, with legacy migration
├── streams.js           →  `delta-stream` port handler: validation, memory agent, budget, batching
├── conversations.js     →  per-record conversation store + metadata index, search, kbFed marking
├── memory-store.js      →  memory notes (markdown tree in storage), path-confined shell-like ops
├── memory-tools.js      →  memory_* tool definitions and the per-request memory agent
├── kb.js                →  curator material, runs, alarm-based automatic maintenance, status
├── expansion-records.js →  log of page expansions (curator material), grouped by page
├── model-catalog.js     →  models.dev catalog (24h cache), endpoint discovery, connection tests
└── keep-alive.js        →  keeps the event page awake during long work
```

## Critical rules
- **Store every AI-facing prompt string in `src/shared/prompts.js`** (the extension's own wording) or
  `packages/core/src/prompts.ts` (shared with the desktop: page context, canvas notes, expand
  instructions, `EXPAND_INTENTS`), which `prompts.js` re-exports. Never inline one elsewhere.
  Content scripts cannot import modules: `EXPAND_INTENTS` is mirrored in `src/content/state.js`; keep them
  in sync with core.
- **Shared logic lives in `@delta/core`.** `src/shared/{canvas,canvas-selection,rich-text,context-budget}.js`
  are one-line re-exports of `packages/core/src/*.ts`. Change the TypeScript there, never add a copy here,
  and remember the desktop runs the same code (`npm run test` covers it). Only module code (background,
  pages) can import core; content scripts are classic scripts and cannot.
- **`browser.*` only, Firefox only.** Background is an ES module (`import`, not `importScripts`).
- **No innerHTML with dynamic content.** Build DOM with `h()` (`src/ui/dom.js`) or `createElement`.
  KaTeX renders through `katex.render` into a node.
- **Model output is untrusted.** Links render only for `http(s)`, images render as alt text, memory
  paths are validated in `memory-store.js` (relative, no `..`, `.md` only), grep is literal.
- **Firefox suspends the background after ~30s idle.** Timers that must survive use `browser.alarms`;
  long work holds `keepAlive()` (`src/background/keep-alive.js`).
- **Broadcast message types must not collide with request types.** Pages listen for
  `kbStatusChanged`, `memoryUpdated`, `conversationsChanged`, `configChanged`, `settingsChanged`,
  `expandShortcut`; page listeners must return `undefined` for everything else, or they would answer
  requests meant for the background.
- **Context menus are re-registered on every background start**, not just `onInstalled`.
- **Content script guard:** `window.__deltaExpandInjected` prevents double injection.

## Messaging
- **Requests** (`browser.runtime.sendMessage({ type, ... })`) are handled by the `handlers` table in
  `background.js`; each returns a value or a Promise.
- **Streaming** uses a Port named `delta-stream`. The client posts `{ type: 'start', kind, ... }`;
  the background answers with batched `{ delta }` messages, then `{ done, text }` or
  `{ error, text, cancelled }`, then disconnects. Disconnecting from the client aborts generation.
  Kinds: `chat` (`role` + full `messages`, used for chat, look-ups and chat expansions) and
  `page-expand` (page context + chain of parent bubbles; the background builds the messages and records
  the expansion for the curator).
- **Shortcuts:** `expand` (Ctrl+E), `expand-prompted` (Alt+Shift+E) and `open-canvas` (Alt+Shift+C) are
  commands. `open-canvas`, the page context menu item and the popup's Canvas button send `openPageCanvas`
  to the tab's top frame.
- **Expand shortcuts:** for `expand` and `expand-prompted` the background sends `pageExpandCommand` to
  the active tab (every frame; only the one with a selection acts) and broadcasts `expandShortcut` for
  the dashboard, popup and canvas page, which never see the key themselves.

## Conversations
- One record per conversation under `deltaConv:<id>`, metadata in `deltaConvIndex` (a canvas's meta
  also holds `pageUrl`). Shape: `{ id, title, createdAt, updatedAt (ISO), kbFed,
  source: 'chat' | 'lookup' | 'canvas', state: { turns }, lookup?: { context, page: { title, url } },
  canvas?: layout }`. Turns: `{ id: number, role, content, expansions,
  error?, attachments? }`.
- Expansions are offset-anchored annotations on a turn's markdown (`src/shared/rich-text.js`), never
  part of the history sent to the model. An expansion request is a follow-up branching from its turn
  (`buildExpandRequest`).
- `kbFed` belongs to a version: a save that keeps `updatedAt` (folding, renaming) keeps it; a content
  change clears it. `migrateConversationRecord` accepts the extension's pre-0.2 shape.

## Canvas
- **The canvas is the desktop's**: model and requests in `@delta/core`, views and state in `@delta/ui`
  (`packages/ui/src/canvas/`, React). Change it there; the desktop runs the same code. The extension
  supplies only the page around it (`canvas/canvas.jsx`) and its host (`src/ui/ui-host.js`).
- **The host** answers the shared UI's `UiHost`: conversations through background requests, streams
  through `delta-stream` Ports turned into the desktop's event shapes (a stop reports the partial text),
  and Ctrl+E from the `expandShortcut` broadcast. Requests are built with core's system prompt; the host
  swaps in the extension's (`getSystemPrompt`) before sending. Export downloads markdown.
- **One page, three places.** `canvas/canvas.html` is the overlay over a web page (`?overlay=1&seed=`),
  a tab (`?id=`), or the dashboard's Canvas route (`?embed=dashboard`, an iframe). The dashboard frames
  it because its plain-DOM chat styles the same class names (`.frame`, `.md-*`, menus) its own way. They
  talk by `postMessage` on the extension's origin: the dashboard sends `delta-canvas-open` (`''`, `new`
  or an id); the frame sends `delta-canvas-shown` (the address), `delta-open-search`,
  `delta-open-conversation` and `delta-dashboard-key` (Ctrl+K, Ctrl+Shift+O, Ctrl+, pressed inside it).
- **Tokens.** The shared stylesheets read the desktop's token names; `src/ui/base.css` defines the ones
  the extension did not have (canvas colours, code colours, shadows, focus rings) in every theme block.
- A canvas is a record with `source: 'canvas'` and a `canvas` layout `{ cards, frames, links, stack,
  viewport }`, normalized on every load (`normalizeCanvasLayout`). Cards: `message`, `expansion`, `note`,
  and the extension's `page` (`{ turnId, title, url }`, its text in a user turn).
- A page card is the first context of every session that continues it: `turnsThroughCard` turns its
  turn into `buildPageContextMessage`, and expansions on it use the page-expand shape
  (`expansionCardRequest` in core's `canvas-request.ts`). Never send a page turn as anything the user said; the curator skips it
  (`pageTurnIds`) except for what was expanded in it.
- Page links are kept: the content script writes the main content's links as `[text](address)` (http(s)
  only, no in-page jumps or overlong addresses, `()<>` and spaces percent-encoded) and appends the page's
  other links as a list. `PAGE_LINKS_NOTE` (`buildPageCanvasContextMessage`) tells the model to hand them
  back as markdown links, copied exactly. Answers render them as links opening in a new tab.
- The page canvas: the content script (`src/content/page-canvas.js`) reads the page as markdown, stashes
  it with `stashCanvasSeed` (in `storage.session`, single use, bound to the tab) and adds an iframe of
  `canvas/canvas.html?overlay=1&seed=<token>`. The frame takes the seed, reopens the newest canvas whose
  meta `pageUrl` matches, or starts one with the page card (`startFromPage`, a question box beside it).
  Embedded without a valid seed it shows nothing. It closes by posting `delta-canvas-close` to its parent,
  from its × button or Esc with nothing left to cancel.

## Markdown and selections
`src/shared/markdown.js` is a classic script defining `globalThis.DeltaMarkdown` (content script,
dashboard chat and popup all load it; the canvas renders with `@delta/ui`'s remark-based `Markdown`). Every node carries source offsets; rendered text nodes are leaf
`[data-src]` spans; code blocks, inline code, math and images are atoms (`data-atom-start/end`).
`anchoredRange` widens a selection to what can become one inline frame and refuses cross-block ranges.
Keep `crossesBlockBoundary` (rich-text) and the parser's block rules consistent.

## Page bubbles
- Every bubble (and its sub-bubbles) is persisted under `(url, frameId)` in `deltaPageBubbles`.
  Anchors are hybrid: serialized XPath, with a text-search fallback.
- Answers render with `DeltaMarkdown.render(..., { inline: true, anchored: false })`; sub-bubbles are
  anchored by XPath into that DOM, so rendering must stay deterministic. Never re-render an answer that
  holds sub-bubbles (regenerate/edit remove them first, after a confirm).
- Rehydrate runs at init, on `pageshow`, and on URL changes (history events plus a 1s URL check,
  because page scripts' `pushState` is invisible through Firefox's Xray wrappers).
- Persist calls are fire-and-forget and suppressed during rehydrate.

## Knowledge Base
- Memories: a markdown tree in `deltaMemories`. Root files named `index*` are auto-loaded into every
  request's system prompt (8k chars each, 16k total); everything else is read on demand via tools.
- Chat, look-ups and page expansions get the memory tools (assistant prompt: write only on request);
  a model the catalog marks tool-less gets the auto-loaded notes as text; an unknown model whose
  endpoint rejects tools (400/404/422 before output) is retried without them.
- The curator (`kb-maintenance` role) gets one pass per conversation or per page of expansions, with
  `toolsRequired`. Automatic passes: 20s debounce after new material, batches of 4, backlog every 45s,
  exponential retry backoff, all via `browser.alarms`. Status persists in `deltaKbState`.
- Legacy `deltaKbData.prompt` migrates once into `index-learning.md`; keywords are dropped.

## Storage keys
`deltaModelConfig`, `deltaSettings`, `deltaConvIndex`, `deltaConv:<id>`, `deltaMemories`,
`deltaKbState`, `deltaExpansionRecords`, `deltaPageBubbles`, `deltaModelCatalog`, `deltaLastLookup`.
`storage.session`: `deltaCanvasSeed:<token>` (page canvas hand-off). `localStorage` on extension pages:
`delta-canvas-minimap`.
Legacy keys migrated and removed on first use: `deltaConfig`, `deltaKbConfig`, `deltaConversations`,
`deltaKbData`.

## Tooling
- `npm run build:extension` / `npm run dev:extension` from the root (see above). `dist/` is ignored.
- The extension's own JS has no typecheck, lint or tests, and is not Prettier-formatted (the root
  `.prettierignore` and ESLint config skip it; `scripts/` is linted and formatted). The shared model it
  imports is tested in `packages/core/tests`, the shared canvas in `packages/ui/tests` (both typechecked
  and linted). Verify UI changes by loading `dist/` in Firefox.
- Automation: WebDriver BiDi (Puppeteer with `browser: 'firefox'`) can install `dist/` as a temporary
  add-on, but only scripts extension pages with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` and cannot navigate to
  `moz-extension:` URLs: open them with `browser.tabs.create` from an extension page reached through the
  web-accessible `canvas/canvas.html`. Pin the UUID with the `extensions.webextensions.uuids` pref.
- `.vscode/` config is user-level (includes C++ settings) — ignore it.
- `ref_src/` is gitignored reference material; the JS files are the source of truth.
