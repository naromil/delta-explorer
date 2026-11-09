# AGENTS.md

## Overview
Firefox MV3 extension, the browser companion to the Delta Explorer desktop app (`~/Projects/delta-ai`).
Its features mirror the desktop app's, including the canvas; the desktop look-up's screen OCR becomes
page text, and any web page can be opened as a canvas whose first card is the page. No build step, no npm dependencies. Files are loaded directly by Firefox. KaTeX is vendored
unmodified in `vendor/katex/`.

## Loading the extension
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json`

## Architecture

```
background.js (module)   →  message router, streaming host (Ports), context menu, commands, KB scheduler
content.js + src/content →  inline page bubbles, injected into all frames (classic scripts, shared scope)
popup/                   →  toolbar look-up (a ConversationView with role 'lookup')
dashboard/               →  Home, Chat, Canvas, Knowledge Base, Guide, Settings (hash routes, ES modules)
canvas/                  →  standalone canvas page: the in-page overlay frame, or a tab
src/ui/                  →  shared page UI: ConversationView, api bridge, dom helpers, attachments, CSS
src/ui/canvas/           →  canvas board (gestures, keys, keyed DOM), store (state, streams, undo, save),
                            panels (rail, selection bar, outline, map, shortcuts), popups, helpers
src/shared/              →  pure logic: prompts, models, conversation, rich-text, context-budget, markdown,
                            canvas* (geometry, sessions, selection, arrange, tidy, history, outline,
                            context links, requests), layered-layout
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
- **Store every AI-facing prompt string in `src/shared/prompts.js`.** Never inline one elsewhere.
  Content scripts cannot import modules: `EXPAND_INTENTS` is mirrored in `src/content/state.js`; keep them
  in sync.
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
- Ported from the desktop's `shared/canvas*.ts`, `hooks/useCanvas.ts` and `views/canvas/*`. The pure
  modules were transpiled and adapted; keep them in step with the desktop when porting changes.
- A canvas is a record with `source: 'canvas'` and a `canvas` layout `{ cards, frames, links, stack,
  viewport }`, normalized on every load (`normalizeCanvasLayout`). Cards: `message`, `expansion`, `note`,
  and the extension's `page` (`{ turnId, title, url }`, its text in a user turn).
- A page card is the first context of every session that continues it: `turnsThroughCard` turns its
  turn into `buildPageContextMessage`, and expansions on it use the page-expand shape
  (`canvas-request.js`). Never send a page turn as anything the user said; the curator skips it
  (`pageTurnIds`) except for what was expanded in it.
- The board has no framework: `derive()` computes what is on screen, `renderNow()` updates DOM kept by
  id (`syncKeyed`). Rebuild a card's text only when it changed, so selections and link animations survive.
- Page links are kept: the content script writes the main content's links as `[text](address)` (http(s)
  only, no in-page jumps or overlong addresses, `()<>` and spaces percent-encoded) and appends the page's
  other links as a list. `PAGE_LINKS_NOTE` (`buildPageCanvasContextMessage`) tells the model to hand them
  back as markdown links, copied exactly. Answers render them as links opening in a new tab.
- The page canvas: the content script (`src/content/page-canvas.js`) reads the page as markdown, stashes
  it with `stashCanvasSeed` (in `storage.session`, single use, bound to the tab) and adds an iframe of
  `canvas/canvas.html?overlay=1&seed=<token>`. The frame takes the seed, reopens the newest canvas whose
  meta `pageUrl` matches, or starts one with the page card. Embedded without a valid seed it shows nothing.
  It closes by posting `delta-canvas-close` to its parent.

## Markdown and selections
`src/shared/markdown.js` is a classic script defining `globalThis.DeltaMarkdown` (content script,
dashboard and popup all load it). Every node carries source offsets; rendered text nodes are leaf
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

## No tooling
- **No package.json, no npm, no Node.js in the repo.**
- **No tests, no lint, no typecheck.** Do not invent or run these commands. Verify UI changes by loading
  the extension in Firefox.
- `.vscode/` config is user-level (includes C++ settings) — ignore it.
- `ref_src/` is gitignored reference material; the JS files are the source of truth.
