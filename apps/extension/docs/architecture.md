# Delta Explorer for Firefox — Architecture

## Overview

A Firefox MV3 extension that mirrors the Delta Explorer desktop app (`~/Projects/delta-ai`) in the
browser. Five surfaces share one background:

| Surface | Where | What it does |
|---|---|---|
| Page bubbles | content script, every frame | Expand selected page text inline; nested, foldable, persisted per page |
| Look-up | toolbar popup | Ask about the current page (selection or page text as context) |
| Dashboard | options page, full tab | Home, Chat, Canvas, Knowledge Base, Guide, Settings |
| Page canvas | iframe over any page (`canvas/canvas.html`) | The page as the first card of a canvas |
| Background | ES module event page | Routing, streaming, model config, conversations, memories, curator |

There is no build step. Shared logic lives in `src/shared/` as ES modules, except
`src/shared/markdown.js`, a classic script so the content script can load it too.

## Desktop → extension mapping

| Delta Explorer (Electron) | Extension |
|---|---|
| Main process IPC handlers | `background.js` `handlers` table (`runtime.sendMessage`) |
| `chat-send` / `chat-expand` / `chat-cancel` | `delta-stream` Port; disconnect cancels |
| `providers.json`, `safeStorage` | `deltaModelConfig` in `storage.local` |
| `{userData}/conversations/*.json` + sidecars | `deltaConv:<id>` + `deltaConvIndex` |
| `{userData}/memories/` files | `deltaMemories` `{ files, dirs }` |
| KB timers (`setTimeout`) | `browser.alarms` + `keepAlive()` |
| Look-up popup with screen OCR | Toolbar popup with page selection/text |
| remark + mdast offsets | `DeltaMarkdown` (own parser, same offset contract) |
| React components | `ConversationView` (`src/ui/conversation-view.js`), plain DOM |
| Canvas (`useCanvas`, `views/canvas/*`) | `CanvasStore` + `CanvasBoard` (`src/ui/canvas/`), plain DOM |
| `shared/canvas*.ts`, `layered-layout.ts` | `src/shared/canvas*.js`, `layered-layout.js` (transpiled, plus page cards) |

## Background (`background.js`, `src/background/`)

- **provider.js** — every provider speaks OpenAI-compatible chat completions; Google uses its
  `/v1beta/openai` endpoint, Ollama `{host}/v1`. Streams SSE, assembles `tool_calls` deltas, runs tools
  and loops up to `maxSteps` (last step `tool_choice: 'none'`). 40s *idle* timeout. A 400/404/422 before
  any output retries once without tools unless `toolsRequired`.
- **streams.js** — handles `delta-stream` ports. Validates messages, builds page-expand messages
  (system, page context, chain of parent bubbles, question), refuses images for a model models.dev
  marks text-only, attaches the memory agent, trims to the context budget, batches deltas every 32ms,
  records finished page expansions.
- **config.js** — connections + role assignments (`chat`, `lookup`, `kb-maintenance`) and settings
  (`theme`, `kbAutoMaintain`, `pageContext`, `pageSelectionBar`). Migrates the old single-provider
  `deltaConfig`/`deltaKbConfig` into one or two connections.
- **conversations.js** — serialized writes; `saveConversation`, `mutateConversation`,
  `renameConversation`, `markConversationKbFed(id, curatedUpdatedAt)`, `searchConversations` (titles
  first, then content with a snippet). Migrates the old `deltaConversations` array.
- **memory-store.js / memory-tools.js** — the document base and its eight tools (`memory_ls`, `cat`,
  `grep`, `write`, `edit`, `mkdir`, `mv`, `rm`). Paths are confined; grep is literal; files are capped at
  32k chars. `memoryAgentFor(role, target, messages)` returns the agent (or text fallback).
- **kb.js** — builds curator material (Questions + Expanded terms, like the desktop's
  `buildSingleMaterial`; pages get one pass per page of expansions), runs passes, schedules automatic
  maintenance with alarms, publishes `kbStatusChanged`.
- **model-catalog.js** — models.dev (24h cache, stale fallback), `/models` discovery, connection tests.

## Content script (`src/content/`, classic scripts in manifest order)

`state` → `anchor` (XPath + text fallback, markers) → `theme` → `dom-utils` → `persistence` →
`stream` (Port per bubble) → `bubble` (create, render markdown, actions, fold, dismiss) → `prompt`
(Expand on… with presets) → `selection-bar` → `rehydrate` → `init` (events, messages, SPA routing).

A bubble entry: `{ id, el, marker, range, data: { selection, context, prompt }, responseText, status,
error, children, parent, folded, port }`. Sub-bubbles live inside the parent's rendered answer and are
anchored by XPath, so answers render deterministically and are never re-rendered while they hold
children.

## Pages (`src/ui/`, `dashboard/`, `popup/`)

`ConversationView` owns a conversation: rendering turns and expansion frames, the composer (with image
attachments), streaming answers and expansions, regenerate/edit/retry, autosave (250ms debounce), the
selection bar, context menu, Expand on… prompt and answer picker. The dashboard's Chat view and the
popup are thin wrappers around it.

Selection → expansion: `DeltaMarkdown.anchorsFromRange` maps DOM offsets to source offsets via
`[data-src]`/atoms, `anchoredRange` widens to a valid inline range, `validateExpansionTarget` checks it,
`insertExpansionInTurns` adds a `loading` node, `buildExpandRequest` builds the branch, chunks apply via
`applyExpansionChunk`.

## Canvas

A canvas is a conversation record (`source: 'canvas'`) with a `canvas` layout. Cards are messages (a
question and its answer), expansions (an `ExpansionNode` in a turn), notes, and page cards. Sessions are
`parentId` chains: a rectangle sharing a side with a card continues it, so a canvas branches and each
branch sends only its own history. Answers are sized by their rectangle (`buildCanvasFitNote`), then the
card's height is fitted to the text. Frames, connections (optionally sending context), undo as patches,
an outline with search, a map, tidy/align and the full keyboard map work as on the desktop; see the desktop
repo's `docs/architecture.md` for the model.

**Page cards** are the extension's addition. `openPageCanvas` (context menu, `Alt+Shift+C`, the popup)
reaches the tab's top frame; `src/content/page-canvas.js` converts the main content to markdown
(headings, lists, emphasis, code, tables and links; markdown syntax in the text escaped), adds the
page's other links (navigation, sidebars, footers; up to 80, 4k chars) as a list, stashes it in
`storage.session` under a single-use token bound to the tab, and overlays `canvas/canvas.html` in a
full-page iframe. The frame takes the seed and reopens the newest canvas with that `pageUrl`, or starts a
new one: the page card at the origin with a question box beside it (an empty question summarizes). The
page text (≤16k chars plus the links list) is the first message of every session continuing the card,
with `PAGE_LINKS_NOTE` asking the model to give links from it as markdown links, copied exactly, and terms selected in
it expand into cards whose request is the page-expand shape (page, earlier expansions, question).

## Storage

| Key | Contents |
|---|---|
| `deltaModelConfig` | `{ schemaVersion, connections, roles }` |
| `deltaSettings` | `{ theme, kbAutoMaintain, pageContext, pageSelectionBar }` |
| `deltaConvIndex`, `deltaConv:<id>` | conversation metadata, records |
| `deltaMemories` | `{ files: { path: markdown }, dirs: [path] }` |
| `deltaKbState` | `{ lastRunAt, lastLearnedAt, lastAnalyzed, lastError, failedAttempts }` |
| `deltaExpansionRecords` | page expansions for the curator (cap 500) |
| `deltaPageBubbles` | `{ "url|frameId": [bubble records] }`, 30-day expiry |
| `deltaModelCatalog` | cached models.dev catalog |
| `deltaLastLookup` | `{ id, at }` for resuming the popup |
| `deltaCanvasSeed:<token>` (session) | `{ tabId, at, seed: { title, url, text } }`, taken once by the canvas frame |

## Permissions

`storage`, `unlimitedStorage` (images and conversations), `contextMenus`, `clipboardWrite`, `tabs`
(look-up context, opening the dashboard and the page canvas), `alarms` (curator scheduling), host `<all_urls>` (content
script everywhere, provider and models.dev requests). The extension-page CSP omits
`upgrade-insecure-requests` so `http://` local model servers keep working.
