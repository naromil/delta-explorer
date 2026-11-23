# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Jump to the matching message when opening a search result — `conversation-search` results would need a turn id (IPC contract change)
- [ ] "See all conversations" under Home's five recents — opens the Ctrl/Cmd+K list, which already lists everything on an empty query, so older chats are one click away
- [ ] Update check — show a "new version available" notice (no auto-install) before other people install the packages
- [ ] Show something while memory tools run — `provider.ts` forwards only text deltas, so tool steps are silent, and `MEMORY_ASSISTANT_WRITE_RULES` tells the model to finish its notes before answering, which delays the first token. Either show a "checking notes…" state, or leave writing to the curator and keep only reads in session
- [ ] Expansion: map of what you've explored — a view of every expanded term across conversations, showing repeats and how they connect, with a jump back to the source. First step: tell the user "you expanded this term before" and offer the earlier answer
- [ ] Ctrl/Cmd+/ opens the keyboard-shortcut list from any view — the list exists only on the Look-up Guide page, where few users will look for it
- [ ] Split `CanvasView.tsx` (2,991 lines) and `useCanvas.ts` (1,432 lines), and move the canvas conventions out of the root `AGENTS.md` (876 lines, loaded into every agent session) into `packages/ui/AGENTS.md`
- [ ] Unit-test `subscribeChatTransport` (`hooks/chat/transport.ts`) — the stale-id drop that keeps late chunks from writing to a dropped turn has no test
- [ ] Unit-test the `memory-*` IPC handlers (`memory/handlers.ts`) — nothing checks that a cut file reports `truncated` (so it can't be saved over the whole one) or that errors never leak an absolute path

## Proposed (needs the owner's OK — move to Routine to approve)

## Ideas for the owner to consider (never built automatically)

- Per-conversation system prompt or persona
- Voice input and read-aloud
- Quick model switcher in the chat composer — pick a different model for one conversation without reassigning the chat role
- Saved prompts / snippets — reusable questions insertable from the composer
- Keep earlier answers on regenerate and page between them ("2 / 3"), as ChatGPT and Claude do — changes the stored `Turn` format

## Rejected (Claude won't re-propose these)

- Pin or star conversations — changes the `ConversationMeta` sidecar format
- Export all conversations / import from a file — needs new IPC channels and a bulk file format
- Conversation history sidebar in the chat view — a layout redesign of the chat screen
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition
- Expansion: dedicated `expand` model role — inline answers should appear almost immediately, but expand uses the chat or lookup model; a fast, cheap role falling back to the current one (new `RoleId`, needs a config-schema migration)
- Show which model produced each answer — adds a field to the stored `Turn` format
- Per-message timestamps — requires adding a field to the stored `Turn` format
- Fork a conversation from a message — a new UX concept that creates a second record from an existing one; the owner should pick the entry point
