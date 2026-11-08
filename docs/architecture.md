# Delta Explorer for Firefox — Architecture

## Overview

A Firefox MV3 extension that mirrors the Delta Explorer desktop app (`~/Projects/delta-ai`) in the
browser. Four surfaces share one background:

| Surface | Where | What it does |
|---|---|---|
| Page bubbles | content script, every frame | Expand selected page text inline; nested, foldable, persisted per page |
| Look-up | toolbar popup | Ask about the current page (selection or page text as context) |
| Dashboard | options page, full tab | Home, Chat, Knowledge Base, Guide, Settings |
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
| Canvas | Not ported |

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

## Permissions

`storage`, `unlimitedStorage` (images and conversations), `contextMenus`, `clipboardWrite`, `tabs`
(look-up context, opening the dashboard), `alarms` (curator scheduling), host `<all_urls>` (content
script everywhere, provider and models.dev requests). The extension-page CSP omits
`upgrade-insecure-requests` so `http://` local model servers keep working.
