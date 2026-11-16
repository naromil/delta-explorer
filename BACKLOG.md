# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Let the user see and correct the memory — the Knowledge view shows only status and the analyze buttons, and the preload has no way to list or read memory files. Add a read-only tree with a viewer, an "open folder" button, and show the curator's one-line "what I changed" reply after each pass
- [ ] Show something while memory tools run — `provider.ts` forwards only text deltas, so tool steps are silent, and `MEMORY_ASSISTANT_WRITE_RULES` tells the model to finish its notes before answering, which delays the first token. Either show a "checking notes…" state, or leave writing to the curator and keep only reads in session
- [ ] Expansion: map of what you've explored — a view of every expanded term across conversations, showing repeats and how they connect, with a jump back to the source. First step: tell the user "you expanded this term before" and offer the earlier answer
- [ ] Split `CanvasView.tsx` (2,991 lines) and `useCanvas.ts` (1,432 lines), and move the canvas conventions out of the root `AGENTS.md` (876 lines, loaded into every agent session) into `packages/ui/AGENTS.md`
- [x] First-run path — a new install with no API key should land on "add a connection" instead of an empty Home
- [ ] Update check — show a "new version available" notice (no auto-install) before other people install the packages
- [x] List the Up-arrow "edit last message" shortcut in the Look-up Guide's Keyboard Shortcuts — it shipped last week but the in-app list still omits it
- [ ] Unit-test `generateConversationTitle` in `main/conversation-title.ts` — its "`null` on any failure, never throws" contract guards every first send and has no test
- [ ] Test that `safeHref` (`ui/lib/safe-url.ts`) agrees with `isSafeExternalUrl` (`window-guards.ts`) — AGENTS.md requires the two allowlists to match and nothing enforces it
- [ ] Unit-test `straightenBlocks` in `canvas-straighten.ts` — the only canvas layout module with no tests, and tidy relies on it never resizing or detaching cards

## Proposed (needs the owner's OK — move to Routine to approve)

- [ ] Per-message timestamps — requires adding a field to the stored `Turn` format
- [ ] Show which model produced each answer — adds a field to the stored `Turn` format
- [ ] Jump to the matching message when opening a search result — `conversation-search` results would need a turn id (IPC contract change)
- [ ] Copy a whole conversation as markdown to the clipboard — needs a new IPC channel or moving the export renderer into `shared/`
- [ ] Remember the main window's size and position — adds a field to the `settings.json` schema
- [ ] Fork a conversation from a message — a new UX concept that creates a second record from an existing one; the owner should pick the entry point
- [ ] Find in conversation (Ctrl/Cmd+F) — Electron shows no find bar; needs `webContents.findInPage` behind a new IPC channel

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
