# The canvas (`@delta/ui/canvas`)

The infinite canvas of answer rectangles, rendered by both apps: the desktop's canvas view and the
extension's canvas page. Read the root `AGENTS.md` first for commands, critical rules and style;
this guide holds what is particular to the canvas. Paths follow the root guide: `ui/<path>` is
`packages/ui/src/<path>`, `shared/<module>` is `packages/core/src/<module>.ts`, and `main/…` is the
desktop's main process. A change here ships in both apps, so test it in both (see
`apps/extension/AGENTS.md` for driving Firefox).

## Files

| File                                                               | Role                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ui/canvas/useCanvas.ts`                                           | The open canvas: loading, saving, undo, streams and the cards the model adds; lives in the app's root  |
| `ui/canvas/canvas-state.ts`                                        | What the hook holds (`CanvasDoc`, `CanvasMeta`) and returns (`CanvasState`), `allocateTurnId`, helpers |
| `ui/canvas/useCanvasLayout.ts`                                     | Layout edits: moving, raising, notes, frames, links, colour, collapsing, duplicating                   |
| `ui/canvas/CanvasView.tsx`                                         | `CanvasBoard`: gestures, drawing, the composer, card actions, menus and what is on screen              |
| `ui/canvas/board-model.ts`                                         | The board's types (`Gesture`, `Draft`, `Placing`, `CanvasNotice`) and its limits and wording           |
| `ui/canvas/useBoardNavigation.ts`                                  | Jumps between cards: focus and reveal, back to a term, links, zoom to items, the view history, flashes |
| `ui/canvas/useBoardSurface.ts`                                     | The wheel on the plane (`useWheelOnPlane`) and focus that never scrolls it (`useFocusOnPlane`)         |
| `ui/canvas/useBoardNotice.ts`                                      | The passing notice on the hint line                                                                    |
| `ui/canvas/CanvasChrome.tsx`                                       | The title bar, zoom bar, empty canvas welcome and hint line                                            |
| `ui/canvas/canvas-menus.ts`                                        | Right-click lists and the history menu                                                                 |
| `ui/canvas/board-helpers.ts`                                       | DOM and wording helpers with no state                                                                  |
| `ui/canvas/Canvas*View.tsx`, `Canvas*`                             | Cards, notes, frames, links, the draft, tool rail, selection bar, outline, map and shortcuts           |
| `ui/canvas/useCanvasKeyboard.ts`, `useEdgePan.ts`, `right-drag.ts` | Board-wide keys and paste, panning near the edge during a drag, the right-drag/menu split              |

## What to touch when

| Task                                   | File(s)                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Canvas geometry, sessions, word fit    | `shared/canvas.ts` (+ `estimateWords` constants mirror `ui/styles/canvas.css`)                                                       |
| Canvas gestures, tools, expansion flow | `ui/canvas/CanvasView.tsx`                                                                                                           |
| Canvas card height and pushing         | `shared/canvas.ts` (`resizeCard`, `resizeCardKeepingClear`, `fitCardHeight`), measured in `CanvasView.tsx`                           |
| Canvas stacking (which card is on top) | `shared/canvas.ts` (`cardStackRanks`, `raisedStack`), `raiseCards` in `ui/canvas/useCanvasLayout.ts`, z-index scale in `canvas.css`  |
| Canvas card buttons                    | `ui/canvas/CanvasCardView.tsx`, `ui/canvas/useCanvas.ts` (`regenerateCard`, `editCard`)                                              |
| Canvas streaming and saving            | `ui/canvas/useCanvas.ts`                                                                                                             |
| Cards the model adds (canvas tools)    | `main/canvas-tools.ts`, `shared/canvas-spawn.ts`, `card` in `useCanvas.ts`'s listener, `buildCanvasToolInstructions`                 |
| Canvas sizing instruction              | `shared/prompts.ts` (`buildCanvasFitNote`)                                                                                           |
| Canvas composer, follow, links         | `ui/canvas/CanvasView.tsx` (+ `nearestCardInDirection` in `canvas.ts`)                                                               |
| Canvas session links and seams         | `shared/canvas.ts` (`canvasContinuations`) + `ui/canvas/CanvasLinks.tsx`                                                             |
| Canvas keys                            | `ui/canvas/useCanvasKeyboard.ts` + `CanvasShortcuts.tsx` (the list); a focused card's own keys in `handleCardKeyDown`                |
| Canvas tools                           | `ui/canvas/CanvasToolRail.tsx` (+ `handleSurfaceDown` and `finishDraw` in `CanvasView.tsx`)                                          |
| Canvas selection and what it moves     | `shared/canvas-selection.ts`, `handleDragStart` in `CanvasView.tsx`                                                                  |
| Canvas align, duplicate                | `shared/canvas-arrange.ts`, `CanvasSelectionBar.tsx`                                                                                 |
| Canvas tidy layout                     | `shared/canvas-tidy.ts` (`tidySelection`)                                                                                            |
| Canvas undo                            | `shared/canvas-history.ts`, `recorded` in `ui/canvas/useCanvas.ts`                                                                   |
| Canvas notes, frames, connections      | `shared/canvas.ts` (types, `normalizeCanvasLayout`), `ui/canvas/useCanvasLayout.ts`, `CanvasNoteView`, `CanvasFrames`, `CanvasLinks` |
| Asking about selected cards            | `shared/canvas-selection.ts` (`sourceExcerpts`), `shared/prompts.ts` (`buildCanvasSourcesNote`), `askAboutSelection`                 |
| Canvas map, outline and search         | `CanvasMinimap.tsx`, `CanvasOutline.tsx`, `shared/canvas-outline.ts`                                                                 |
| Context links, composer attachments    | `shared/canvas-context.ts`, `shared/prompts.ts` (`buildCanvasContextNote`), `CanvasDraft.tsx`, `linkMenuItems`                       |
| Resizing a draft                       | `shared/canvas.ts` (`resizeDraftRect`), `draftResize` gesture in `CanvasView.tsx`                                                    |

## Conventions

- **Select is the default tool; a press decides by where it lands.** On a title it selects and can
  drag, in a body it selects text (a plain click selects the card, `handleCardClick`), on empty space it
  starts a marquee. A press that never travels `DRAG_START_PX` is a click. Double clicks are counted by
  hand (`isDoublePress`), because a claimed press captures the pointer and `dblclick` would reach the
  surface; the press that opens an editor must then cancel its own `mousedown`, or focus leaves the
  editor and closes it. The selection bar sits at the bottom because at the top it covered the title
  bars of the cards a Fit puts there.
- **Tidying straightens attached cards and arranges everything else.** The unit is a block: cards attached
  by a shared side, or a frame and its contents. `straightenBlocks` moves cards inside a block only to line
  edges up, never resizing them or giving up a session seam, and drops a result no cleaner than what
  stands; a block with a frame is left alone. Parent-child relationships (`parentId`, `hostId`) between
  blocks form a family, drawn as trees (`layOutFamily`): every child stays on the side of its parent it
  stood on (`directionOf`, in half-size units, down on a tie), children on one side stack in the order
  they stood, centred on the parent, and `placeSide` keeps them far enough out that a second tidy reads
  the same sides and changes nothing. Families are packed by bounding box with `FAMILY_GAP` around them. Drawn links and asked-about lines
  never join anything: `orderBoxes` keeps their families adjacent and swaps positions while that lowers
  crossings, then lines over other cards, then total line length. Lines do not route around cards. When
  nothing would move it returns `{ ok: false }` and the view says so.
- **A page card belongs to the extension, but its model is shared.** `kind: 'page'` holds a web page's
  text in a user turn (`turnId`, `title`, `url`). It roots every session that continues it:
  `turnsThroughCard` sends it as `buildPageCanvasContextMessage`, and a term expanded on it is asked as
  a fresh expand instruction rather than an ancestor question. It has no source, never fits its
  height, stays single on duplicate, and shows read-only (no edit or regenerate) with a link to its page.
  Its text expands like an answer (`canExpandTurn`), asked with the page as context, and a blank question
  continuing it asks for a summary.
- **Colour labels are scoped to `.canvas-view`.** `[data-color]` sets `--tint`, and a note, a frame, the map and the outline each
  give `--tint` a default in a rule of their own, so the colour rules carry the extra class to win over those defaults.
- **A note is a card, a frame and a connection are not.** A note (`kind: 'note'`) stands on the plane
  like any card, so it snaps, joins and may overlap, but holds no turn, so it continues no session
  (`continuationCandidates`) and curator passes never see it: note edits save with `touchContent: false`.
  A blank note never reaches the document (`noteDraft`). Frames sit under the cards and are no obstacle;
  only the title and corner take the pointer, so a marquee can start inside one. Membership is
  geometric and read when a frame moves. Removing a frame keeps its cards. `layout.frames` and
  `layout.links` are always arrays after `normalizeCanvasLayout`; older records read as empty.
- **Undo is patches, because answers keep streaming.** `recorded(label, action)` in `useCanvas` diffs
  by identity around one user action, so everything that edits the document must copy only what it
  edits. `applyCanvasPatch` puts back only what that action changed. Moving, resizing, colour, notes,
  frames, connections, duplicate and delete are undoable; asking, expanding, height fitting and
  bringing a card forward are not recorded. Regenerate and edit are not either, and their confirmation still says so. The stacks are
  per open canvas and in memory only. The double confirmation for taking other cards along stays, with
  wording that says Ctrl+Z works; deleting only what was explicitly selected asks nothing.
- **Asking about a selection is material, not history.** `card.sources` names the cards, and
  `withCanvasSources` puts their text (`SOURCE_TEXT_LIMIT` each) in the newest user message at request
  time only, like `withCanvasFit`, so stored turns never carry it. A single top-level answer continues
  instead, as its history is better context. `askedAboutRelations` draws the dashed lines for this, except
  from the card it continues, which already has its mark from `canvasContinuations`.
- **A link can send context, and that context belongs to the branch.** `CanvasLink.context` is
  `'card'` (the start's text) or `'branch'` (everything through the start); without it a link is only
  a drawing. `requestContext` walks the sending card's session (`sessionCardIds`), so a link reaches
  every later card on that branch and regenerating, but not sibling branches. It is read at request
  time and put in the newest user message (`withCanvasContext`), so turns never carry it and editing a
  note changes the next request. It stops at one hop, so links cannot cycle. Turns already in the
  history or sent by another link appear once, and the text is capped (`TOTAL_TEXT_LIMIT`) because the
  context budget never trims the newest message. Expansions on the branch receive it too. Links
  added after an answer do not change that answer until it is regenerated.
- **The composer attaches context before anything exists.** `Draft.context` holds pending links;
  `ask` turns them into real ones. A context link is drawn dashed. Dragging a card, a note or a card's `+` onto the draft links it
  (`overDraft`, `linkToDraft`), and everything selected goes along; a dragged card then returns to
  where it stood. A text box is an ordinary note dragged there. Links further up the branch show as
  inherited chips. A draft cannot send while a linked answer is streaming.
- **A `+` is a click or a drag.** It claims the press (`extend` gesture), so its `onClick` is only the
  keyboard's. A click continues on that side. Let go in open space and an `unheld` draw follows the
  pointer from there until the next click (`handleSizingPress` takes that press before a card's own
  handlers), and the draft continues that card wherever it stands; no travel gives the default size.
- **A draft resizes from the corner away from its parent** (`draftGrowth`, `resizeDraftRect`), by
  drag or Alt+arrows, and may grow over other cards. `estimateWords` follows, so this is how the answer's length is chosen.
- **Far out, a card is its title.** Below `FAR_ZOOM` the surface gets `data-far` at rest, and
  `.canvas-card-lod` covers the card with its title scaled against the zoom. The header and body are
  `visibility: hidden`, never `display: none`, because a card finishing out there still measures its
  answer. `.canvas-card-body` has `scrollbar-gutter: stable`: without it a fitted answer can wrap one
  line longer under the scrollbar it had, and so keep the scrollbar.
- **Collapsing goes through `resizeCard`** (`setCardCollapsed`), so what is joined below follows.
  `collapsedFrom` is the height to return to, and anything sizing from a card (`openCardSize`) must use
  that, not `rect.h`. Regenerate
  reopens first, as the rectangle decides the length.
- **The plane moves outside React.** Wheel zoom, wheel pan, drag pan and arrow keys go through
  `createViewportMotion`: frames ease with `chaseViewport` and are painted directly, with the layer
  promoted (`data-moving`), and `setViewport` runs once the view rests. So `viewportRef` is the live
  value and `viewport` can lag; `claimPress` and `glideTo` call `settle()` before relying on it. The
  transform and grid are never React style props (`paintViewport`), and `--canvas-zoom` changes only
  at rest because every card inherits it. A `glideTo` eases by CSS instead, so the surface transitions
  its dots (`is-animating`) with the same timing as the world, or they would jump ahead of the cards.
- **A canvas answer can add cards beside itself.** A canvas card's `chat-send` carries
  `canvas: { explore }`, and main adds `canvas_add_visual` and (when `explore`) `canvas_add_explore`
  and `canvas_suggest` to the memory tools (`withCanvasTools`, more steps, limits in `CANVAS_SPAWN_LIMITS`), with
  `buildCanvasToolInstructions`: the answer stays text, and visuals go in cards. The tools only
  report: each call sends `chat-card` to the asking window, and `useCanvas` builds the card. A visual
  card is a finished message card (the title as its question, the model's markdown as its answer); an
  exploration waits until its answer completes (dropped if stopped or failed), then is asked as a
  continuation. Both continue the answering card (`parentId`), are marked `spawned`, and carry
  `relation`, which `CanvasLinks` writes on their session line. `spawnRect` places them by role
  (`spawnRole`): an exploration's `role` puts background on the answer's left, deeper on its right
  (the default), examples below; visuals always go below (fitting the answer pushes them down). Once
  the answer, its explorations and their fits have all finished, `useCanvas` tidies the family
  (`settleSpawns`): only cards the agent placed that the user hasn't moved (`agentPlacedRef`, cleared
  by any user `moveItems`, in memory only), laid out as a tree around the answer, which itself never
  moves; one "Arrange answer" undo step, skipped when it would land on another card. A spawned card gets only the visual tool, so branching
  stays one level deep per question. Regenerating the answer drops them as it drops any continuation.
  An answer gets at most 2 answered explorations; further directions go through `canvas_suggest`
  (up to 4, a question main has already taken for this answer is refused): `useCanvas` keeps them on
  the answering card (`suggestions`, sound via `soundSuggestions`) and `CanvasCardView` shows them as
  buttons under a finished answer. A click (`askSuggestion`) takes the suggestion off the card and asks
  it as an ordinary continuation placed by its role: not `spawned` and not agent-placed, since the user
  chose it, so it may add cards of its own and the settling tidy leaves it alone. A new answer on the
  card (send, Retry, Regenerate, Edit) clears the old suggestions.
  No tools means no cards: a tool-less model, an expand, or the extension's host (which ignores the
  flag) answer as before. Claude Code reaches the tools over MCP like the memory tools.
- **A rectangle decides the answer's length.** `estimateWords(rect, captionChars, charWidth)` mirrors
  the card typography in `canvas.css`; change them together. It counts paragraphs, whose last lines
  and gaps use up more of a wide card, and `bodyCharWidth` (`ui/lib/char-width.ts`) measures the font. `withCanvasFit` appends the size to the newest
  user message at request time only, so turns never store it, and the note overrides the system
  prompt's default length and expand's four-sentence limit.
- **A drag moves what was chosen; touching cards are joined when resizing or with Shift.** A plain drag
  or nudge moves only the selection. Shift+drag moves everything
  joined by a shared side (`movingCardIds`), and align, tidy and duplicate still treat joined cards as one
  block. Since Shift also adds to a selection, a Shift press only toggles once it is let go without
  travelling (`shiftPress`). Resizing (`resizeCard`) carries the cards beyond the moved edge both
  ways, plus anything joined only through them (`edgeFollowers`); a card also joined by another route
  keeps its place. Joined cards never land on each other: a resize pushes one it reaches, and shrinking
  stops where a follower can come back no further. Anything not joined stays where it is, so the card
  may end up over it.
- **Cards may overlap wherever the user puts them; nothing automatic covers one.** Drawing, dragging,
  nudging, resizing, arranging and undo never refuse a landing. Placement nobody aimed still looks for
  open space (`adjacentSlot`, `rectClearOf`), and a change of size nobody aimed (answer fitting, reopening
  a collapsed card) goes through `resizeCardKeepingClear`, which treats every card as a manual resize
  treats joined ones, leaving pairs that already overlapped alone. A drawn rectangle overlapping a card without sharing a side starts a new session.
- **The pile is `layout.stack`, not the order of `layout.cards`.** That order means age (newest
  continuation, the card Enter continues) and sets the DOM order, and moving a node would lose its
  scroll, focus and text selection, so cards never reorder: `cardStackRanks` turns the stack into an
  inline `z-index`. Cards the stack does not name sit above those it does, so a new card needs no
  bookkeeping. A press (`raisePressedCard`), a
  selection or a move calls `raiseCards`, which does nothing unless something actually covers the card,
  so a plain click saves nothing. Hit tests use `cardAtPoint`, which reads the stack. Anything meant to
  sit above every card uses a z-index from 100000 (see `canvas.css`); a seam under a third card is left out.
- **A finished answer then fits its card's height, never its width.** `useCanvas` marks a card when
  its answer completes normally (not stopped, not failed), and `CanvasBoard` measures it on screen
  (`measureCardHeight` reads the scroll height of a body squeezed to nothing, so margins and tall
  formulas that escape the text's box are counted) and applies `fitCardHeight`, so an answer that finished in another view fits on return. It resizes
  as `resizeCard` does. A body still scrolls when the card
  cannot change: a card that
  cannot shrink because what hangs below cannot follow.
- **Regenerate and Retry are one action sized by the card's current rectangle** (`regenerateCard`).
  Like chat it drops what came after: every card in `cascadeCardIds`. Anything that takes other cards
  along, delete included, confirms twice (`confirmCascade`); a card nothing depends on deletes at once.
- **Sides are sessions.** Drawing with a side against a card (`continuationParent`, snapped by
  `snapEdges`) continues it; anywhere else starts a new session. A rectangle touching several cards
  continues one only (`continuationCandidates`, newest first) and sends only that history; the
  drawing highlights it (`is-continued`) and the draft's "Continues" picker can switch to another
  candidate or to a new session. Alt+drag pulls a card off its parent and neighbours, bringing the descendants attached
  to it (`pulledOutCardIds`; one reached by a link stays) and leaving its session history (`parentId`) intact.
- **The draft is the canvas's composer, and the viewport follows it like a pinned chat.** Sending
  closes it; the next one opens on request (Enter continues the card just sent, or a card's `+`), kept
  against its parent through `Draft.side` as the card grows or moves; it cannot send while the answer
  it continues is streaming or failed.
  `followRef` keeps the draft and its parent on screen (or just the draft, under the answer's newest
  lines, when both do not fit); any manual pan, wheel or zoom lets go, typing in the draft or "Back
  to your question" re-pins. A streaming card body sticks to its newest line (`nextPinned`).
- **A session always shows between its cards.** `canvasContinuations` gives each continuation, and each expansion touching its host, one
  mark pointing from the earlier card to the later one: on the boundary they share (`seam`) when they
  touch, otherwise a link. Touching alone joins cards but says nothing about history, so a boundary
  with no mark is two cards merely placed together, and a card joined to its parent only through a
  third card still gets a link. A `+` shows wherever it has open space to sit (`continueHandleBlocked`), since a drag can place the next message even when a click has no room beside the card. A card lying under the `+`'s own card only counts where it shows beyond that card's edge.
- **Canvas is keyboard-drivable.** Cards are focusable: arrows move to `nearestCardInDirection`,
  Enter/Shift+Enter continue below/right, B goes back (`sourceCardId`; an expansion returns to the whole
  card holding its term, flashed and scrolled into view, by `revealWholeCard`, which never zooms out
  so far that cards become titles), E edits, Delete deletes, PgUp/PgDn scroll. With no card
  focused, Enter opens the composer, N a new session, arrows pan, +/−/0 zoom, `?` lists them all.
  Clicking a link travels to its farther end. Focus never scrolls the plane: drafts and editors
  focus with `preventScroll`, and the surface resets any scroll a focus causes; only the viewport
  moves it.
- **Canvas gestures cancel `mousedown`, never `pointerdown`.** Cancelling `pointerdown` suppresses the
  `mousedown` that `ContextMenu` and `ExpandPrompt` use to notice an outside click, so they would stay
  open. `claimPress` marks the press, and `handleSurfaceMouseDown` cancels it and releases focus.
- **A right drag pans and a right click opens a menu, on every platform.** `contextmenu` fires on press
  on Linux and macOS and on release on Windows, so `createRightDrag` (`ui/canvas/right-drag.ts`) holds it from a capture handler and
  decides at release: after a drag it is dropped, otherwise it is dispatched again on what was pressed,
  so the card, frame, link, text and plane menus need no knowledge of this. The pointer is captured only
  once the press becomes a drag, since capture would retarget the menu.
- **Canvas expansions are `ExpansionNode`s shown as cards.** `useExpansionContextMenu` chooses the
  term, then `CanvasView` holds it as `Placing` until a rectangle is drawn or clicked. The term stays in
  `ExpansionNode`; the card is a card like any other, wherever it is drawn or dropped, even over its
  host, and `CanvasLinks` draws the link from the term, under the cards and faintly over them so it never strikes through text. The faint copy
  is left out when a card higher in the pile hides either end of the line (`isCoveredAt`), and the whole line when that card is
  the line's own other end, as with a small card lying behind its parent; session links and connections follow the same rule (`reachOf`). Offsets are
  measured relative to the scaled `.canvas-card-surface`, which stays correct mid-animation.
  `folded` has no meaning on a canvas. Nothing depends on a card lying inside another: `normalizeCanvasLayout` drops the `inset` flag older canvases stored. A wrapped term's link starts at the middle of its longest line
  (`termPoint`), since the middle of its bounding box can be empty space.
- **The map follows the viewport without rendering.** `paintViewport` calls `CanvasMinimap.paint`, which
  sets the SVG `viewBox` and view rectangle directly. The `viewBox` is held still during a drag on the
  map, or the map would slide from under the pointer. Whether it is open is the one thing kept in
  `localStorage`, as a per-viewer convenience.
- **A passage can be linked like a card.** On the canvas the selection bar's Link… makes a context
  link with `quote`: it joins an open composer as a chip, otherwise the next click picks the card that
  receives it. `contextExcerpts` sends only the passage, as a `<quote>`, even when its card is in the
  history, and each passage counts once beside any whole-card link from the same source.
