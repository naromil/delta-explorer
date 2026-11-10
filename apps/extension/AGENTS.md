# AGENTS.md

## Overview
MV3 extension for Firefox and Chrome, the browser companion to the Delta Explorer desktop app. Both live in one
monorepo: this is the `@delta/extension` workspace (`apps/extension`), the desktop app is
`apps/desktop`, and the pure logic they share is `@delta/core` (`packages/core`, TypeScript).
Its features mirror the desktop app's, including the canvas; the desktop look-up's screen OCR becomes
page text, and any web page can be opened as a canvas whose first card is the page. KaTeX is vendored
unmodified in `vendor/katex/`.

## Building and loading the extension
The browsers load `dist/firefox/` and `dist/chrome/`, never the sources: the pages and the background
import `@delta/core`, which only a bundler can resolve.
1. From the repository root: `npm install`, then `npm run build:extension` (or
   `npm run dev:extension` to rebuild on every change, into `dist/dev/firefox/` and
   `dist/dev/chrome/` instead). Both browsers are built; pass `-- --browser=firefox` (or `chrome`)
   to build one.
2. Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
   `apps/extension/dist/firefox/manifest.json`.
3. Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `apps/extension/dist/chrome/`.

While `npm run dev:extension` runs, a build loaded from `dist/dev/` reloads itself after every rebuild, so it is
loaded once and never reloaded by hand. The watcher serves a WebSocket on `127.0.0.1:35730`
(`DELTA_RELOAD_PORT` changes it); the manifest's background becomes `dev-background.js`, which
imports `background.js` and `src/dev/auto-reload.js`. That module takes the first build id it
receives as its baseline (`storage.session`, cleared by a reload) and calls `runtime.reload()` on a
new one. Tabs that were already open keep the old content script until they are refreshed. A release
build (`npm run build:extension`, also run by `npm run verify`) has none of this, and each kind of
build clears only its own folders, so neither breaks the other while a browser has it loaded.

`scripts/build.mjs` bundles the four module entries (`background.js`, `popup/popup.js`,
`dashboard/js/app.js`, `canvas/canvas.jsx`, the one React page) with esbuild, unminified, plus
`canvas/canvas-ui.css` (the shared canvas styles and KaTeX's, fonts written to `assets/`). It copies
everything else that ships: manifest, HTML, CSS, icons, `vendor/`, and the classic scripts named by the
manifest's content scripts or loaded by a page without `type="module"`. A new module file needs nothing;
a new classic script must be referenced from the manifest or a page's HTML to be copied.

## Chrome
The sources are written for Firefox; `scripts/build.mjs` makes the Chrome build from them:
- **`browser.*` comes from the WebExtension polyfill.** Chrome has only `chrome.*`, and its
  `runtime.onMessage` cannot answer with a returned Promise, which every handler here does. Each module
  bundle gets `src/chrome/browser-global.js` injected first, and `vendor/browser-polyfill.min.js` is
  prepended to the content scripts. Keep writing `browser.*` with Promises.
- **The manifest is derived** (`chromeManifest`): the background becomes a module service worker, icons
  are the PNGs in `icons/` (Chrome reads no SVG), `browser_specific_settings` is dropped, and some
  suggested keys change (`CHROME_SUGGESTED_KEYS`). Edit `manifest.json` only.
- **The background is a service worker there**: no DOM, no `window`, no dynamic `import()`, and every
  listener registered synchronously at the top level, as now. The same keep-alive works.
- **Shortcuts.** Chrome never assigns a suggested key that is one of its own shortcuts: Ctrl+E (so
  `expand` has no default there) and Alt+Shift+C (`open-canvas` is Alt+Shift+V). Pages take Ctrl+E
  themselves: the extension pages already did, and on web pages the content script does when
  `IS_CHROME` (`src/content/init.js`; Ctrl+Shift+E asks first). Chrome has no `commands.update`, so the
  Shortcuts settings link to `chrome://extensions/shortcuts`.
- **Chrome is stricter about what it loads.** A content script must be valid UTF-8 without
  noncharacters (write `\uFFFF`, never the character), and `tabs.query({ url })` cannot match an
  extension page (filter by `tab.url` instead). Messages are JSON-serialized, not structured-cloned.

## Architecture

```
background.js (module)   →  message router, streaming host (Ports), context menu, commands, KB scheduler
content.js + src/content →  inline page bubbles, page canvas reader, web chat driver (classic scripts,
                            shared scope, all frames)
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
- **`browser.*` only, never `chrome.*`.** The Chrome build defines `browser` (see Chrome). Background is
  an ES module (`import`, not `importScripts`); it must also run as Chrome's service worker.
- **No innerHTML with dynamic content.** Build DOM with `h()` (`src/ui/dom.js`) or `createElement`.
  KaTeX renders through `katex.render` into a node.
- **Model output is untrusted.** Links render only for `http(s)`, images render as alt text, memory
  paths are validated in `memory-store.js` (relative, no `..`, `.md` only), grep is literal.
- **Firefox suspends the background after ~30s idle** (Chrome's service worker likewise). Timers that must survive use `browser.alarms`;
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
  commands (Chrome's defaults differ, see Chrome). `open-canvas`, the page context menu item and the popup's Canvas button send `openPageCanvas`
  to the tab's top frame.
- **Web chat port:** a canvas over a web chat connects a Port named `delta-web-chat` to the background,
  which pipes it to the top frame of the canvas's own tab (`src/background/web-chat-relay.js`; only the
  canvas page may connect). The frame cannot reach the tab's content script by itself. `{ type: 'read' }` answers
  `{ chat }`; `{ type: 'ask', prompt }` answers `{ accepted }`, `{ text }` snapshots (whole text, not
  deltas), then `{ done, text, url }` or `{ error, text }`. Disconnecting stops the chat's reply.
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
  The web chat canvas plugs in through `useCanvas(asker)` (questions go to the asker instead of the host),
  `addImported`/`setWebChat` (the chat's exchanges and binding) and `beginAt` (fit, notice, composer).
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

## Web chat canvas
- On ChatGPT, Claude and Gemini the page canvas mirrors the conversation instead of reading the page:
  `openPageCanvas` stashes `webChat: { site, name, url, exchanges: [{ question, answer }] }` in the seed,
  read by `src/content/web-chat.js` (answers converted to markdown by page-canvas.js's converter, which
  also keeps KaTeX as `$…$` and code languages).
- The canvas binds `layout.webChat = { site, url, exchanges }` (core `CanvasWebChat`): `exchanges` names
  the card holding each of the chat's exchanges in order, null where none does. Exchanges become a
  chain of message cards (`importWebChatExchanges`); reopening the canvas over the same chat
  (`pageUrl` is the chat's address) imports only what is new.
- While its tab holds it (a `CanvasAsker` passed to `useCanvas`, `createWebChatAsker` in
  `src/ui/canvas/web-chat.js`), every question goes to the
  chat, one at a time in a queue, instead of the user's model. The chat cannot branch, so every
  question is asked at its end, framed by `src/shared/web-chat-request.js` with the wording in
  `prompts.js` (`buildWebChat*`): plain when continuing the latest reply, otherwise naming the earlier
  answer, quoting the selected passage, or carrying an answer the chat never saw. The prompt is built
  when its turn in the queue comes, so "latest" is right. The question claims its exchange slot once
  the chat shows it; regenerating a card moves the slot to the new exchange.
- Anywhere else (a tab, the dashboard) the same canvas asks the user's own model and says so.
- Site adapters are selector lists in `WEB_CHAT_SITES`. Chat sites change markup without notice: when
  one breaks, fix its selectors there; every failure reports what it could not find. Typing goes
  through the site's `fillers` order (`WEB_CHAT_FILLERS`: `execCommand` typing, a synthetic paste,
  or paragraphs written into the editor plus an input event, which Quill on Gemini needs). The
  composer is emptied before each try, and nothing is sent until it reads back as exactly the
  prompt; a failure lists what was tried. Screen-reader-only labels ("You said") are never read.

- **Known limitations (2026-11-10).** Checked by automation on ChatGPT only (Claude in Chrome with the dev
  hooks, see Tooling); the other sites by hand:
  - ChatGPT (fixed 2026-11-10): questions are `[data-user-message-bubble]`, answers
    `[data-chatgpt-selection-message-id]` with the body in `[data-markdown-copy="contents"]`, bold runs
    are `span[data-d-default-strong]` (no `<strong>`), Send is `form button[type=submit][aria-label="Send"]`
    and Stop `button[aria-label="Stop"]`. Loaded answers stay hidden for ~2.6 s and are revealed over
    ~1.4 s, which `readWebChatSettled` waits out. Reading a chat and asking a question (accepted,
    snapshots, done) were verified in a temporary chat; long chats and regenerated answers were not.
  - Gemini: questions reach the chat. The earlier mix-up of typing methods (a question arrived as "r") is
    fixed by verifying the composer text before sending, but that fix is unverified. One imported card
    showed "1" as Gemini's reply, unexplained; replies may be read from the wrong element.
  - Claude: never tried.
  - Sites that take older turns off the page in long chats would import incompletely and break the
    count-based parts (exchange slots); suspected, not confirmed.
  - An edit made on the site that keeps the message count is not noticed; deleting messages there
    only truncates the slots.
  - "Finished" means no Stop button and unchanged text for 1.2 s; a selector that matches a Stop button
    that never goes away keeps a card loading until the 3-minute stall timeout.

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
- Chrome automation: Puppeteer with `pipe: true, enableExtensions: true` and
  `browser.installExtension('apps/extension/dist/chrome')` (Chrome 137+ ignores `--load-extension`);
  the service worker is a `service_worker` target, and extension pages open as `chrome-extension://<id>/…`.
- The extension's own JS has no typecheck, lint or tests, and is not Prettier-formatted (the root
  `.prettierignore` and ESLint config skip it; `scripts/` is linted and formatted). The shared model it
  imports is tested in `packages/core/tests`, the shared canvas in `packages/ui/tests` (both typechecked
  and linted). Verify UI changes by loading `dist/` in Firefox.
- Claude in Chrome (the user's own Chrome, signed in to the chat sites): load `dist/dev/chrome` once and
  keep `npm run dev:extension` running; refresh a tab after a rebuild for its new content script. Its
  simulated keys never reach extension shortcuts, so drive the extension through the dev-only
  `src/dev/page-hooks.js`: dispatch `delta-dev` on `document` with a JSON string `{ action, … }` and
  read `delta-dev-result` (`read-web-chat`, `read-web-chat-settled`, `open-canvas`, `canvas-state`,
  `canvas-records`, and `ask`, which sends a real message: use a temporary chat). While the canvas
  iframe is open, Claude in Chrome can neither script nor screenshot that tab.
- Automation: WebDriver BiDi (Puppeteer with `browser: 'firefox'`) can install `dist/` as a temporary
  add-on, but only scripts extension pages with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` and cannot navigate to
  `moz-extension:` URLs: open them with `browser.tabs.create` from an extension page reached through the
  web-accessible `canvas/canvas.html`. Pin the UUID with the `extensions.webextensions.uuids` pref.
- `.vscode/` config is user-level (includes C++ settings) — ignore it.
- `ref_src/` is gitignored reference material; the JS files are the source of truth.
