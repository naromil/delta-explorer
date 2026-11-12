# Backlog — maintained by Claude's weekly planner. Move items between sections to steer it.

## Routine (Claude may build these without asking)

- [ ] Have AI-based conversation title generation at first message.
- [x] Right-click Cut/Copy/Paste and spelling suggestions in text fields — Electron shows no context menu by default, so the composer, look-up Ask field and editors have none
- [x] Ignore Enter during IME composition in the remaining single-line editors (chat title rename, canvas title, frame and link labels, canvas outline search, model picker) — CJK input commits or jumps mid-composition
- [x] Up arrow in an empty chat composer edits the last user message — a standard chat-app shortcut that reuses the existing edit-and-resend path
- [ ] Change the toolbar for text selection in canvas. Add a way to highlight the text selection. Add a way to link the text selection to another object (the same way as giving a new rectangle context from another branch). Leave the original direct "Expand" and custom prompt "Ask..." on the main toolbar, and the other prompt presets moved into a secondary menu.
- [ ] Make canvas tidy-up feature respect the original up/down/left/right directional layout between chunks (cards attached to each other), instead of listing by strict hierarchy (which often ends up twining all the links visually).
- [ ] Unify the chat and lookup model configuration into one configuration. Knowledge maintenance stays separate. Add more model provider presets beyond the 5 ones.
- [x] Unit-test `renderMath` in `lib/math.ts` — nothing guards `trust: false`, the one safeguard on the renderer's only `dangerouslySetInnerHTML` (`\href{javascript:…}` must not produce a link)
- [ ] Unit-test `formatRelativeTime` in `lib/format.ts` — the Home recents labels have untested 1m/1h/24h/7d boundaries
- [ ] Add Claude Code headless mode as a provider choice in settings.
- [ ] Add highlight feature where users can highlight a text in a response. The knowledge base maintenance will pay special attention to that as it is what the user thinks is important or useful.

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
- Expansion: map of what you've explored — a view of every expanded term across conversations, showing repeats and how they connect, with a jump back to the source; fits "conversations are learning materials" and could reuse an earlier answer when a term comes back
- Quick model switcher in the chat composer — pick a different model for one conversation without reassigning the chat role
- Saved prompts / snippets — reusable questions insertable from the composer

## Rejected (Claude won't re-propose these)

- Pin or star conversations — changes the `ConversationMeta` sidecar format
- Export all conversations / import from a file — needs new IPC channels and a bulk file format
- Conversation history sidebar in the chat view — a layout redesign of the chat screen
- Quiz / flashcard mode built from the KB profile and history, with spaced repetition
- Expansion: dedicated `expand` model role — inline answers should appear almost immediately, but expand uses the chat or lookup model; a fast, cheap role falling back to the current one (new `RoleId`, needs a config-schema migration)
