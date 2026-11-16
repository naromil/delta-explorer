import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type {
  CanvasCard,
  CanvasExpansionCard,
  CanvasLink,
  CanvasPoint,
  CanvasRect,
  CanvasSide
} from '@delta/core/canvas'
import {
  askedAboutRelations,
  canvasContinuations,
  clampPointInside,
  connectorGeometry,
  containsPoint,
  isCoveredAt,
  sourceCardId,
  termLinkGeometry
} from '@delta/core/canvas'
import { termPoint } from './board-helpers'

interface CanvasLinksProps {
  cards: CanvasCard[]
  stackRanks: ReadonlyMap<string, number>
  links: CanvasLink[]
  surfaceRef: RefObject<HTMLDivElement | null>
  /** Links of cards being dragged follow the pointer instead of easing after it. */
  dragging: boolean
  selectedIds: ReadonlySet<string>
  /** Cards shown faded, while a search or a term being placed singles out the others. */
  dimmedIds: ReadonlySet<string>
  /** A connection whose label is open for typing. */
  editingLinkId: string | null
  /** A connection being drawn: from a card to the pointer, or to the card under it. */
  pending: { from: CanvasRect; to: CanvasRect } | null
  /** What the open composer will send: lines from each linked card to it. */
  draftLinks: Array<{ id: string; from: CanvasRect; to: CanvasRect }>
  /** A click on a link, which travels to whichever end is farther from the click. */
  onFollow: (e: React.MouseEvent, id: string, start: CanvasPoint) => void
  /** A click on the faint line of a card asked about, which works the same way. */
  onFollowRelation: (e: React.MouseEvent, from: string, to: string) => void
  onSelectLink: (e: React.MouseEvent, id: string) => void
  onLinkMenu: (e: React.MouseEvent, id: string) => void
  onEditLink: (id: string | null) => void
  onLabelLink: (id: string, label: string) => void
}

type TermOffsets = Readonly<Record<string, CanvasPoint>>

const SIDE_ANGLE: Readonly<Record<CanvasSide, number>> = {
  right: 0,
  bottom: 90,
  left: 180,
  top: 270
}

const QUOTE_PREVIEW_LENGTH = 80

function quotePreview(quote: string): string {
  const flat = quote.replace(/\s+/g, ' ').trim()
  return flat.length > QUOTE_PREVIEW_LENGTH ? `${flat.slice(0, QUOTE_PREVIEW_LENGTH)}…` : flat
}

function isLinked(card: CanvasCard): card is CanvasExpansionCard {
  return card.kind === 'expansion'
}

/**
 * Where each term's link starts, relative to its host card. Both come from the same DOM
 * reading of the scaled surface, so the result holds while a card lands, lifts
 * or the zoom is mid-transition.
 */
function measureTermOffsets(cards: CanvasCard[], surface: HTMLElement): TermOffsets {
  const offsets: Record<string, CanvasPoint> = {}
  for (const card of cards) {
    if (!isLinked(card)) continue
    const host = cards.find((other) => other.id === card.hostId)
    const hostEl = surface.querySelector(`[data-canvas-card="${card.hostId}"] .canvas-card-surface`)
    const term = hostEl?.querySelector(`[data-canvas-terms~="${card.expansionId}"]`)
    // A term that is not laid out, in a collapsed card, has no place of its own.
    if (!host || !hostEl || !term || term.getClientRects().length === 0) continue
    const hostBox = hostEl.getBoundingClientRect()
    const point = termPoint(term)
    const scale = hostBox.width / host.rect.w
    offsets[card.id] = {
      x: (point.x - hostBox.left) / scale,
      y: (point.y - hostBox.top) / scale
    }
  }
  return offsets
}

function sameOffsets(a: TermOffsets, b: TermOffsets): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(
    (key) =>
      b[key] !== undefined &&
      Math.abs(a[key].x - b[key].x) < 0.5 &&
      Math.abs(a[key].y - b[key].y) < 0.5
  )
}

function LinkLine({
  d,
  arrow = false,
  dashed = false
}: {
  d: string
  arrow?: boolean
  dashed?: boolean
}): React.JSX.Element {
  // A normalised length is only for the draw-in animation; it would stretch real dashes.
  return (
    <path
      className="canvas-link-line"
      pathLength={dashed ? undefined : 1}
      markerEnd={arrow ? 'url(#canvas-arrow)' : undefined}
      style={{ d: `path("${d}")` } as React.CSSProperties}
    />
  )
}

/** How much of a line is drawn: all of it, only the part under the cards, or nothing. */
type LineReach = 'all' | 'under' | 'none'

const ARROW = 'M -8 -4.5 L 0 0 L -8 4.5 Z'
const CHEVRON = 'M -1.75 -3.5 L 1.75 0 L -1.75 3.5'

/** A mark that keeps its size on screen at any zoom, pointing the way a session travels. */
function pointerStyle(at: CanvasPoint, side: CanvasSide): React.CSSProperties {
  const place = `translate(${at.x}px, ${at.y}px) rotate(${SIDE_ANGLE[side]}deg)`
  return { transform: `${place} scale(calc(1 / var(--canvas-zoom)))` }
}

function LabelEditor({
  label,
  onDone
}: {
  label: string
  onDone: (label: string | null) => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
    inputRef.current?.select()
  }, [])

  const finish = (value: string | null): void => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(value)
  }

  return (
    <input
      ref={inputRef}
      className="canvas-connector-input"
      aria-label="How these two relate"
      placeholder="relates to…"
      defaultValue={label}
      onBlur={(e) => finish(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') finish(e.currentTarget.value)
        else if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

/**
 * Every line on the plane: a term to its expansion once it stands on its own, the
 * connections the user drew, faint lines from cards asked about, and for each continuation
 * a mark on the boundary the two cards share, or a link when they do not touch. A boundary
 * with no mark is two cards merely placed together.
 */
function CanvasLinks({
  cards,
  stackRanks,
  links,
  surfaceRef,
  dragging,
  selectedIds,
  dimmedIds,
  editingLinkId,
  pending,
  draftLinks,
  onFollow,
  onFollowRelation,
  onSelectLink,
  onLinkMenu,
  onEditLink,
  onLabelLink
}: CanvasLinksProps): React.JSX.Element {
  const [offsets, setOffsets] = useState<TermOffsets>({})

  const measure = (): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const next = measureTermOffsets(cards, surface)
    setOffsets((prev) => (sameOffsets(prev, next) ? prev : next))
  }

  // Text reflows as answers stream, so every render may move a term.
  useLayoutEffect(measure)

  // The surface ref is attached after this child's first layout effect, so the
  // first real measurement happens here.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const handleScroll = (): void => {
      const next = measureTermOffsets(cards, surface)
      setOffsets((prev) => (sameOffsets(prev, next) ? prev : next))
    }
    handleScroll()
    surface.addEventListener('scroll', handleScroll, true)
    return () => surface.removeEventListener('scroll', handleScroll, true)
  }, [cards, surfaceRef])

  const rectOf = new Map(cards.map((card) => [card.id, card.rect]))
  const cardOf = new Map(cards.map((card) => [card.id, card]))
  const continuations = canvasContinuations(cards)
  const allSeams = continuations.filter((item) => item.kind === 'seam')
  // Seams are drawn above every card, so one under a third card has to be left out.
  const rankOf = (id: string | undefined): number => (id ? (stackRanks.get(id) ?? -1) : -1)
  const seams = allSeams.filter(({ id, start, end }) => {
    const card = cardOf.get(id)
    const level = Math.max(rankOf(id), rankOf(card && sourceCardId(card)))
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    return !cards.some((other) => rankOf(other.id) > level && containsPoint(other.rect, middle))
  })
  /*
   * The faint copy over the cards leads the eye to an end of the line, so it is left out
   * when a card lying on top hides that end. When the card hiding it is the line's own
   * other card, one lies on the other and no line between them means anything.
   */
  const reachOf = (from: string, start: CanvasPoint, to: string, end: CanvasPoint): LineReach => {
    const fromCard = cardOf.get(from)
    const toCard = cardOf.get(to)
    if (!fromCard || !toCard) return 'none'
    if (
      isCoveredAt([toCard], stackRanks, from, start) ||
      isCoveredAt([fromCard], stackRanks, to, end)
    ) {
      return 'none'
    }
    const hidden =
      isCoveredAt(cards, stackRanks, from, start) || isCoveredAt(cards, stackRanks, to, end)
    return hidden ? 'under' : 'all'
  }
  const dimClass = (from: string, to: string): string =>
    dimmedIds.has(from) || dimmedIds.has(to) ? ' is-dimmed' : ''
  const sessionLinks = continuations.flatMap((item) => {
    const card = cardOf.get(item.id)
    const parent = card && sourceCardId(card)
    if (item.kind !== 'link' || parent === undefined) return []
    const reach = reachOf(parent, item.start, item.id, item.end)
    return reach === 'none' ? [] : [{ ...item, reach, dim: dimClass(parent, item.id) }]
  })
  const termLinks = cards.filter(isLinked).flatMap((card) => {
    if (allSeams.some((seam) => seam.id === card.id)) return []
    const host = cardOf.get(card.hostId)
    if (!host) return []
    const raw = offsets[card.id] ?? { x: host.rect.w / 2, y: host.rect.h / 2 }
    // A term scrolled out of its card hands its link to the card's edge.
    const from = clampPointInside({ x: host.rect.x + raw.x, y: host.rect.y + raw.y }, host.rect)
    const { d, end } = termLinkGeometry(from, card.rect)
    const reach = reachOf(host.id, from, card.id, end)
    return reach === 'none'
      ? []
      : [{ id: card.id, from, d, reach, dim: dimClass(host.id, card.id) }]
  })
  const connectors = links.flatMap((link) => {
    const from = rectOf.get(link.from)
    const to = rectOf.get(link.to)
    if (!from || !to) return []
    const geometry = connectorGeometry(from, to)
    const reach = reachOf(link.from, geometry.start, link.to, geometry.end)
    if (reach === 'none') return []
    const classes = [
      'canvas-connector',
      link.context ? 'canvas-connector--context' : '',
      selectedIds.has(link.id) ? 'is-selected' : ''
    ]
    return [
      {
        link,
        reach,
        d: geometry.d,
        mid: geometry.mid,
        dim: dimClass(link.from, link.to),
        className: classes.filter(Boolean).join(' ')
      }
    ]
  })
  const relations = askedAboutRelations(cards).flatMap((relation) => {
    const from = rectOf.get(relation.from)
    const to = rectOf.get(relation.to)
    return from && to
      ? [
          {
            ...relation,
            d: connectorGeometry(from, to).d,
            dim: dimClass(relation.from, relation.to)
          }
        ]
      : []
  })
  const pendingLines = [
    ...draftLinks.map(({ id, from, to }) => ({
      id,
      className: 'canvas-link-line canvas-link-line--pending canvas-link-line--context',
      d: connectorGeometry(from, to).d
    })),
    ...(pending
      ? [
          {
            id: 'pending',
            className: 'canvas-link-line canvas-link-line--pending',
            d: connectorGeometry(pending.from, pending.to).d
          }
        ]
      : [])
  ]
  const dragClass = dragging ? ' is-dragging' : ''

  // Drawn twice: strong under the cards for open space, and faint over them so a
  // link can be traced back to its term without striking through the text. Only the
  // part under the cards takes clicks, so a link never steals one meant for text.
  return (
    <>
      <svg className={`canvas-links canvas-links--under${dragClass}`} aria-hidden="true">
        <defs>
          <marker
            id="canvas-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M1 1.5L9 5l-8 3.5z" fill="context-stroke" />
          </marker>
        </defs>
        {relations.map(({ from, to, d, dim }) => (
          <g key={`${from} ${to}`} className={`canvas-relation${dim}`}>
            <path className="canvas-relation-line" d={d} markerEnd="url(#canvas-arrow)" />
            <path className="canvas-link-hit" d={d} onClick={(e) => onFollowRelation(e, from, to)}>
              <title>Follow this link</title>
            </path>
          </g>
        ))}
        {termLinks.map(({ id, d, from, dim }) => (
          <g key={id} className={dim || undefined}>
            <LinkLine d={d} />
            <path className="canvas-link-hit" d={d} onClick={(e) => onFollow(e, id, from)}>
              <title>Follow this link</title>
            </path>
          </g>
        ))}
        {connectors.map(({ link, d, dim, className }) => (
          <g key={link.id} className={`${className}${dim}`} data-canvas-link={link.id}>
            <LinkLine d={d} arrow dashed={Boolean(link.context)} />
            <path
              className="canvas-link-hit"
              d={d}
              onClick={(e) => onSelectLink(e, link.id)}
              onContextMenu={(e) => onLinkMenu(e, link.id)}
            >
              <title>
                {link.quote
                  ? `Sends the passage “${quotePreview(link.quote)}” as context. Double-click to label`
                  : link.context === 'branch'
                    ? 'Sends the whole branch as context. Double-click to label'
                    : link.context === 'card'
                      ? 'Sends this card as context. Double-click to label'
                      : 'Double-click to label'}
              </title>
            </path>
          </g>
        ))}
        {sessionLinks.map(({ id, d, start, end, side, dim }) => (
          <g key={id} className={dim || undefined} data-canvas-session-link={id}>
            <LinkLine d={d} />
            <path className="canvas-link-arrow" d={ARROW} style={pointerStyle(end, side)} />
            <path className="canvas-link-hit" d={d} onClick={(e) => onFollow(e, id, start)}>
              <title>Follow this link</title>
            </path>
          </g>
        ))}
        {pendingLines.map(({ id, className, d }) => (
          <path key={id} className={className} d={d} markerEnd="url(#canvas-arrow)" />
        ))}
      </svg>
      <svg className={`canvas-links canvas-links--over${dragClass}`} aria-hidden="true">
        {termLinks.map(({ id, d, from, reach, dim }) =>
          reach === 'all' ? (
            <g key={id} className={dim || undefined}>
              <LinkLine d={d} />
              <circle className="canvas-link-dot" cx={from.x} cy={from.y} r={3.5} />
            </g>
          ) : null
        )}
        {connectors.map(({ link, d, reach, dim, className }) =>
          reach === 'all' ? (
            <g key={link.id} className={`${className}${dim}`}>
              <LinkLine d={d} dashed={Boolean(link.context)} />
            </g>
          ) : null
        )}
        {sessionLinks.map(({ id, d, end, side, reach, dim }) =>
          reach === 'all' ? (
            <g key={id} className={dim || undefined}>
              <LinkLine d={d} />
              <path className="canvas-link-arrow" d={ARROW} style={pointerStyle(end, side)} />
            </g>
          ) : null
        )}
        {pendingLines.map(({ id, className, d }) => (
          <path key={id} className={className} d={d} />
        ))}
      </svg>
      <svg className={`canvas-links canvas-links--seams${dragClass}`} aria-hidden="true">
        {seams.map(({ id, start, end, side }) => (
          <g
            key={id}
            className={`canvas-seam${dimClass(id, sourceCardId(cardOf.get(id) as CanvasCard) ?? id)}`}
            data-canvas-seam={id}
          >
            <path
              className="canvas-seam-line"
              style={{ d: `path("M ${start.x} ${start.y} L ${end.x} ${end.y}")` }}
            />
            <g
              className="canvas-seam-mark"
              style={pointerStyle({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, side)}
            >
              <circle r={8} />
              <path d={CHEVRON} />
            </g>
          </g>
        ))}
      </svg>
      {sessionLinks.map(({ id, start, end, dim }) => {
        const card = cards.find((item) => item.id === id)
        const relation = card?.kind === 'message' ? card.relation : undefined
        if (!relation) return null
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
        return (
          <div
            key={`relation-${id}`}
            className={`canvas-connector-label canvas-relation-label${dim}`}
            style={{ transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)` }}
          >
            {relation}
          </div>
        )
      })}
      {connectors.map(({ link, mid, dim }) => {
        const editing = editingLinkId === link.id
        if (!editing && !link.label) return null
        return (
          <div
            key={link.id}
            className={`canvas-connector-label${selectedIds.has(link.id) ? ' is-selected' : ''}${dim}${dragClass}`}
            style={{ transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)` }}
            onClick={(e) => onSelectLink(e, link.id)}
            onContextMenu={(e) => onLinkMenu(e, link.id)}
          >
            {editing ? (
              <LabelEditor
                label={link.label ?? ''}
                onDone={(label) => {
                  if (label !== null) onLabelLink(link.id, label)
                  onEditLink(null)
                }}
              />
            ) : (
              link.label
            )}
          </div>
        )
      })}
    </>
  )
}

export default CanvasLinks
