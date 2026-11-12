# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [x] Have AI-based conversation title generation at first message.
- [x] Right-click Cut/Copy/Paste and spelling suggestions in text fields — Electron shows no context menu by default, so the composer, look-up Ask field and editors have none
- [x] Ignore Enter during IME composition in the remaining single-line editors (chat title rename, canvas title, frame and link labels, canvas outline search, model picker) — CJK input commits or jumps mid-composition
- [x] Up arrow in an empty chat composer edits the last user message — a standard chat-app shortcut that reuses the existing edit-and-resend path
- [x] Change the toolbar for text selection in canvas. Add a way to highlight the text selection. Add a way to link the text selection to another object (the same way as giving a new rectangle context from another branch). Leave the original direct "Expand" and custom prompt "Ask..." on the main toolbar, and the other prompt presets moved into a secondary menu.
- [x] Make canvas tidy-up feature respect the original up/down/left/right directional layout between chunks (cards attached to each other), instead of listing by strict hierarchy (which often ends up twining all the links visually).
- [x] Unify the chat and lookup model configuration into one configuration. Knowledge maintenance stays separate. Add more model provider presets beyond the 5 ones.
- [x] Unit-test `renderMath` in `lib/math.ts` — nothing guards `trust: false`, the one safeguard on the renderer's only `dangerouslySetInnerHTML` (`\href{javascript:…}` must not produce a link)
- [x] Unit-test `formatRelativeTime` in `lib/format.ts` — the Home recents labels have untested 1m/1h/24h/7d boundaries
- [x] Add Claude Code headless mode as a provider choice in settings.
- [x] Add highlight feature where users can highlight a text in a response. The knowledge base maintenance will pay special attention to that as it is what the user thinks is important or useful.
- [ ] Let the user see and correct the memory — the Knowledge view shows only status and the analyze buttons, and the preload has no way to list or read memory files. Add a read-only tree with a viewer, an "open folder" button, and show the curator's one-line "what I changed" reply after each pass
- [ ] Show something while memory tools run — `provider.ts` forwards only text deltas, so tool steps are silent, and `MEMORY_ASSISTANT_WRITE_RULES` tells the model to finish its notes before answering, which delays the first token. Either show a "checking notes…" state, or leave writing to the curator and keep only reads in session
- [ ] Expansion: map of what you've explored — a view of every expanded term across conversations, showing repeats and how they connect, with a jump back to the source. First step: tell the user "you expanded this term before" and offer the earlier answer
- [ ] Revisit the blanket concision rule in `DELTA_SYSTEM_PROMPT` ("Always answer in simple and concise words. Summarize in a few sentences if the answer is long.") — it conflicts with tailoring depth to the learner and the canvas fit note already overrides it. Let `index-learning.md` set depth and keep the hard limit only in `LOOKUP_WINDOW_NOTE`
- [ ] Split `CanvasView.tsx` (2,991 lines) and `useCanvas.ts` (1,432 lines), and move the canvas conventions out of the root `AGENTS.md` (876 lines, loaded into every agent session) into `packages/ui/AGENTS.md`
- [ ] Check the 40-second idle timeout in `provider.ts` against reasoning models — the timer resets on every stream part, so a provider that thinks silently for longer before its first token would be cut off as "timed out". Not reproduced yet
- [ ] Fix `apps/desktop/package.json`: `homepage` points at `naromil/delta-ai` but `repository` at `naromil/delta-explorer.git`; one is stale
- [ ] Fix the root README: it calls the extension "The Firefox extension" (it builds for Chrome too) and its table omits `packages/ui`
- [ ] First-run path — a new install with no API key should land on "add a connection" instead of an empty Home
- [ ] Update check — show a "new version available" notice (no auto-install) before other people install the packages

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Per-message timestamps — requires adding a field to the stored `Turn` format
- [ ] Show which model produced each answer — adds a field to the stored `Turn` format
- [ ] Jump to the matching message when opening a search result — `conversation-search` results would need a turn id (IPC contract change)
- [ ] Copy a whole conversation as markdown to the clipboard — needs a new IPC channel or moving the export renderer into `shared/`
- [ ] Remember the main window's size and position — adds a field to the `settings.json` schema
- [ ] Fork a conversation from a message — a new UX concept that creates a second record from an existing one; the owner should pick the entry point

## Ideas for the owner to consider (never built automatically)

- Per-conversation system prompt or persona
- Voice input and read-aloud
- Quick model switcher in the chat composer — pick a different model for one conversation without reassigning the chat role
- Saved prompts / snippets — reusable questions insertable from the composer

## Rejected (Claude won't re-propose these)

- Pin or star conversations — changes the `ConversationMeta` sidecar format
- Export all conversations / import from a file — needs new IPC channels and a bulk file format
- Conversation history sidebar in the chat view — a layout redesign of the chat screen
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition
- Expansion: dedicated `expand` model role — inline answers should appear almost immediately, but expand uses the chat or lookup model; a fast, cheap role falling back to the current one (new `RoleId`, needs a config-schema migration)
