import { useEffect, useId, useMemo, useState } from 'react'
import type { VisualBlockKind } from '@delta/core/prompts'
import type { Vars } from '../lib/math-expression'
import { layoutNetwork } from '../lib/network-layout'
import type { LayoutPoint } from '../lib/network-layout'
import type {
  ChartFrame,
  Graph,
  GraphParam,
  NetworkEdge,
  TraceFrame,
  Visual,
  VisualItem,
  VisualSection,
  VisualTreeNode
} from '../lib/visuals'
import { parseVisual, startValues } from '../lib/visuals'

/**
 * A diagram drawn from a fenced block. Everything is a span, because inside an expansion frame
 * the markdown host is itself a span; CSS gives them their boxes. The block is one selection
 * atom, like the code block it replaces, and "Text" shows the source it was drawn from.
 *
 * Diagrams that move are paced by the reader: ordered ones rest showing everything and step
 * on request, a chart or trace with frames always stands on one, and a graph's parameters
 * are sliders. Motion between states is CSS, so `prefers-reduced-motion` turns it off there.
 */

interface VisualBlockProps {
  'data-kind'?: string
  'data-source'?: string
  'data-atom-start'?: number
  'data-atom-end'?: number
}

/* ---- Stepping ---- */

const STEP_MS = 1700

type IconName = 'play' | 'pause' | 'back' | 'forward'

const ICON_PATHS: Record<IconName, string> = {
  play: 'M4 2.5v11l9-5.5z',
  pause: 'M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z',
  back: 'M10.5 2.5L5 8l5.5 5.5',
  forward: 'M5.5 2.5L11 8l-5.5 5.5'
}

function Icon({ name }: { name: IconName }): React.JSX.Element {
  const stroked = name === 'back' || name === 'forward'
  return (
    <svg
      className={`md-visual-icon${stroked ? ' is-stroked' : ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/** `is-current` for the step being shown, `is-ahead` for those not reached; nothing at rest. */
function stepClass(index: number, step: number | null): string {
  if (step === null) return ''
  return index === step ? ' is-current' : index > step ? ' is-ahead' : ''
}

/**
 * A diagram with `count` states and the controls to move through them. With `rest` it starts
 * on none (`step` is null and everything shows, as a static diagram would); otherwise it
 * always stands on one. Play walks to the last state and stops there.
 */
function Stepped({
  count,
  rest,
  label,
  children
}: {
  count: number
  rest: boolean
  label?: (step: number) => string
  children: (step: number | null) => React.JSX.Element
}): React.JSX.Element {
  const [at, setAt] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const last = count - 1
  const step = at === null ? (rest ? null : 0) : Math.min(at, last)

  useEffect(() => {
    if (!playing) return
    const timer = window.setTimeout(() => {
      const next = Math.min((step ?? -1) + 1, last)
      setAt(next)
      if (next >= last) setPlaying(false)
    }, STEP_MS)
    return () => window.clearTimeout(timer)
  }, [playing, step, last])

  const go = (next: number): void => {
    setPlaying(false)
    setAt(Math.min(last, Math.max(0, next)))
  }
  const togglePlay = (): void => {
    if (playing) return setPlaying(false)
    if (step === null || step >= last) setAt(0)
    setPlaying(true)
  }

  return (
    <span className="md-visual-stepped" data-stepping={step === null ? undefined : ''}>
      {children(step)}
      {count > 1 ? (
        <span className="md-visual-controls">
          <button
            type="button"
            className="md-visual-control"
            title="Previous step"
            disabled={step === null || step === 0}
            onClick={() => go((step ?? 0) - 1)}
          >
            <Icon name="back" />
          </button>
          <button
            type="button"
            className="md-visual-control"
            title={playing ? 'Pause' : 'Play step by step'}
            onClick={togglePlay}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button
            type="button"
            className="md-visual-control"
            title="Next step"
            disabled={step !== null && step >= last}
            onClick={() => go((step ?? -1) + 1)}
          >
            <Icon name="forward" />
          </button>
          <span className="md-visual-progress">
            {step === null ? `${count} steps` : `${step + 1} / ${count}`}
            {step !== null && label?.(step) ? ` · ${label(step)}` : ''}
          </span>
          {rest && step !== null ? (
            <button
              type="button"
              className="md-visual-control md-visual-control--text"
              title="Show every step again"
              onClick={() => {
                setPlaying(false)
                setAt(null)
              }}
            >
              Show all
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

function ItemText({ item }: { item: VisualItem }): React.JSX.Element {
  return (
    <>
      <span className="md-visual-title">{item.title}</span>
      {item.detail ? <span className="md-visual-detail">{item.detail}</span> : null}
    </>
  )
}

function Flow({ items, step }: { items: VisualItem[]; step: number | null }): React.JSX.Element {
  return (
    <span className="md-visual-flow">
      {items.map((item, index) => (
        <span key={index} className={`md-visual-step${stepClass(index, step)}`}>
          {index > 0 ? <span className="md-visual-arrow" aria-hidden="true" /> : null}
          <span className="md-visual-box">
            <span className="md-visual-index">{index + 1}</span>
            <ItemText item={item} />
          </span>
        </span>
      ))}
    </span>
  )
}

const RING = 38

function ringPoint(angle: number): { x: number; y: number } {
  return { x: 50 + RING * Math.cos(angle), y: 50 + RING * Math.sin(angle) }
}

/** Stages on a ring, with an arrow along it from each to the next. */
function Cycle({ items, step }: { items: VisualItem[]; step: number | null }): React.JSX.Element {
  const markerId = `md-visual-arrow-${useId().replace(/:/g, '')}`
  const angleOf = (index: number): number => (index / items.length) * 2 * Math.PI - Math.PI / 2
  // Arcs leave room for the stage boxes, which sit over the ring.
  const pad = Math.min(0.42, Math.PI / items.length - 0.08)
  const arcs =
    items.length < 2
      ? []
      : items.map((_, index) => {
          const from = ringPoint(angleOf(index) + pad)
          const to = ringPoint(angleOf(index + 1) - pad)
          return `M ${from.x} ${from.y} A ${RING} ${RING} 0 0 1 ${to.x} ${to.y}`
        })
  return (
    <span className="md-visual-cycle">
      <span className="md-visual-ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto"
            >
              <path d="M1 1.5L9 5l-8 3.5z" />
            </marker>
          </defs>
          {arcs.map((d, index) => (
            // Arc `index` leads into stage `index + 1`, so it belongs to that step.
            <path
              key={index}
              className={stepClass(index + 1, step).trim() || undefined}
              d={d}
              markerEnd={`url(#${markerId})`}
            />
          ))}
        </svg>
        {items.map((item, index) => {
          const point = ringPoint(angleOf(index))
          return (
            <span
              key={index}
              className={`md-visual-box md-visual-stage${stepClass(index, step)}`}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
            >
              <ItemText item={item} />
            </span>
          )
        })}
      </span>
      {/* Narrow cards cannot fit a ring; this list replaces it there (see markdown.css). */}
      <span className="md-visual-cycle-list">
        <Flow items={items} step={step} />
        <span className="md-visual-repeat">↻ then back to {items[0]?.title}</span>
      </span>
    </span>
  )
}

function Timeline({
  items,
  step
}: {
  items: VisualItem[]
  step: number | null
}): React.JSX.Element {
  return (
    <span className="md-visual-timeline">
      {items.map((item, index) => (
        <span key={index} className={`md-visual-event${stepClass(index, step)}`}>
          <span className="md-visual-dot" aria-hidden="true" />
          <span className="md-visual-when">{item.title}</span>
          {item.detail ? <span className="md-visual-detail">{item.detail}</span> : null}
        </span>
      ))}
    </span>
  )
}

/** Every node's place in the order the tree was written, which is the order it plays in. */
function treeOrder(roots: VisualTreeNode[]): Map<VisualTreeNode, number> {
  const order = new Map<VisualTreeNode, number>()
  const walk = (node: VisualTreeNode): void => {
    order.set(node, order.size)
    node.children.forEach(walk)
  }
  roots.forEach(walk)
  return order
}

interface TreeStep {
  order: Map<VisualTreeNode, number>
  step: number | null
}

function TreeNode({
  node,
  depth,
  at
}: {
  node: VisualTreeNode
  depth: number
  at: TreeStep
}): React.JSX.Element {
  return (
    <span className={`md-visual-node${depth === 0 ? ' is-root' : ''}`}>
      <span className={`md-visual-box${stepClass(at.order.get(node) ?? 0, at.step)}`}>
        <ItemText item={node} />
      </span>
      {node.children.length > 0 ? (
        <span className="md-visual-children">
          {node.children.map((child, index) => (
            <TreeNode key={index} node={child} depth={depth + 1} at={at} />
          ))}
        </span>
      ) : null}
    </span>
  )
}

function Tree({ roots }: { roots: VisualTreeNode[] }): React.JSX.Element {
  const order = useMemo(() => treeOrder(roots), [roots])
  return (
    <Stepped count={order.size} rest>
      {(step) => (
        <span className="md-visual-tree">
          {roots.map((root, index) => (
            <TreeNode key={index} node={root} depth={0} at={{ order, step }} />
          ))}
        </span>
      )}
    </Stepped>
  )
}

function SectionItems({ items }: { items: string[] }): React.JSX.Element {
  return (
    <span className="md-visual-items">
      {items.map((item, index) => (
        <span key={index} className="md-visual-item">
          {item}
        </span>
      ))}
    </span>
  )
}

const EMPTY_SECTION: VisualSection = { heading: '', items: [] }

function Venn({ sections }: { sections: VisualSection[] }): React.JSX.Element {
  const [left = EMPTY_SECTION, right = EMPTY_SECTION, both = EMPTY_SECTION] = sections
  return (
    <span className="md-visual-venn">
      <span className="md-visual-set md-visual-set--left" aria-hidden="true" />
      <span className="md-visual-set md-visual-set--right" aria-hidden="true" />
      <span className="md-visual-region">
        <span className="md-visual-title">{left.heading}</span>
        <SectionItems items={left.items} />
      </span>
      <span className="md-visual-region md-visual-region--both">
        <span className="md-visual-title">{both.heading || 'Both'}</span>
        <SectionItems items={both.items} />
      </span>
      <span className="md-visual-region">
        <span className="md-visual-title">{right.heading}</span>
        <SectionItems items={right.items} />
      </span>
    </span>
  )
}

function Matrix({
  sections,
  x,
  y
}: {
  sections: VisualSection[]
  x?: [string, string]
  y?: [string, string]
}): React.JSX.Element {
  const cells = [0, 1, 2, 3].map((index) => sections[index] ?? EMPTY_SECTION)
  return (
    <span className={`md-visual-matrix${y ? ' has-y' : ''}${x ? ' has-x' : ''}`}>
      {y ? (
        <span className="md-visual-axis md-visual-axis--y" aria-label="Vertical axis">
          <span>{y[1]}</span>
          <span>{y[0]}</span>
        </span>
      ) : null}
      <span className="md-visual-quadrants">
        {cells.map((cell, index) => (
          <span key={index} className="md-visual-quadrant">
            {cell.heading ? <span className="md-visual-title">{cell.heading}</span> : null}
            <SectionItems items={cell.items} />
          </span>
        ))}
      </span>
      {x ? (
        <span className="md-visual-axis md-visual-axis--x" aria-label="Horizontal axis">
          <span>{x[0]}</span>
          <span>{x[1]} →</span>
        </span>
      ) : null}
    </span>
  )
}

/* ---- Network ---- */

/** The drawing's own units; the box keeps this shape, so they scale evenly. */
const NET = { width: 150, height: 100, padX: 20, padY: 9, gapX: 36, gapY: 19 }
/** How far a link bows aside when another joins the same two nodes. */
const NET_BEND = 9
const NET_LOOP = 7

interface NetworkLine {
  d: string
  label: LayoutPoint
  /** Arrowheads: where each sits and the way it points, in degrees. */
  heads: Array<LayoutPoint & { angle: number }>
}

function curvePoint(a: LayoutPoint, c: LayoutPoint, b: LayoutPoint, t: number): LayoutPoint {
  const u = 1 - t
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y
  }
}

function headAt(
  a: LayoutPoint,
  c: LayoutPoint,
  b: LayoutPoint,
  t: number,
  backwards: boolean
): LayoutPoint & { angle: number } {
  const here = curvePoint(a, c, b, t)
  const next = curvePoint(a, c, b, t + (backwards ? -0.02 : 0.02))
  return { ...here, angle: (Math.atan2(next.y - here.y, next.x - here.x) * 180) / Math.PI }
}

/** A link that returns to its own node: a ring on the node's outer side. */
function loopLine(at: LayoutPoint, directed: boolean): NetworkLine {
  const dx = at.x - NET.width / 2
  const dy = at.y - NET.height / 2
  const length = Math.hypot(dx, dy)
  const out = length < 1 ? { x: 0, y: -1 } : { x: dx / length, y: dy / length }
  const centre = { x: at.x + out.x * NET_LOOP * 1.9, y: at.y + out.y * NET_LOOP * 1.9 }
  const far = { x: centre.x + out.x * NET_LOOP, y: centre.y + out.y * NET_LOOP }
  const near = { x: centre.x - out.x * NET_LOOP, y: centre.y - out.y * NET_LOOP }
  return {
    d: `M ${near.x} ${near.y} A ${NET_LOOP} ${NET_LOOP} 0 1 1 ${far.x} ${far.y} A ${NET_LOOP} ${NET_LOOP} 0 1 1 ${near.x} ${near.y}`,
    label: { x: far.x + out.x * 5, y: far.y + out.y * 5 },
    heads: directed ? [{ ...far, angle: (Math.atan2(out.x, -out.y) * 180) / Math.PI }] : []
  }
}

/**
 * Each link as a curve between its nodes' centres, which the node boxes cover. So an arrowhead
 * sits along the line rather than at its end, where a box of unknown size would hide it.
 */
function networkLines(edges: NetworkEdge[], points: LayoutPoint[]): NetworkLine[] {
  return edges.map((edge, index) => {
    const a = points[edge.from]
    const b = points[edge.to]
    if (edge.from === edge.to) return loopLine(a, edge.direction !== 'none')
    const shared = edges.some(
      (other, at) =>
        at !== index &&
        ((other.from === edge.from && other.to === edge.to) ||
          (other.from === edge.to && other.to === edge.from))
    )
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
    // Sideways as seen along the link, so the link back bows the other way.
    const bend = shared ? NET_BEND : 0
    const c = {
      x: (a.x + b.x) / 2 - ((b.y - a.y) / length) * bend,
      y: (a.y + b.y) / 2 + ((b.x - a.x) / length) * bend
    }
    return {
      d: `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`,
      label: curvePoint(a, c, b, 0.5),
      heads: [
        ...(edge.direction === 'none' ? [] : [headAt(a, c, b, 0.72, false)]),
        ...(edge.direction === 'both' ? [headAt(a, c, b, 0.28, true)] : [])
      ]
    }
  })
}

const LINK_MARK: Record<NetworkEdge['direction'], string> = { forward: '→', both: '↔', none: '—' }

/** Nodes joined by labelled links; a step is one link, in the order they were written. */
function Network({
  nodes,
  edges,
  step
}: {
  nodes: string[]
  edges: NetworkEdge[]
  step: number | null
}): React.JSX.Element {
  const points = useMemo(() => layoutNetwork(nodes.length, edges, NET), [nodes.length, edges])
  const lines = useMemo(() => networkLines(edges, points), [edges, points])
  const left = (x: number): string => `${(x / NET.width) * 100}%`
  const top = (y: number): string => `${(y / NET.height) * 100}%`
  /** A node appears with the first link that names it; one no link names is always there. */
  const nodeClass = (index: number): string => {
    if (step === null) return ''
    const first = edges.findIndex((edge) => edge.from === index || edge.to === index)
    const current = edges[step]
    if (current && (current.from === index || current.to === index)) return ' is-current'
    return first > step ? ' is-ahead' : ''
  }
  return (
    <span className="md-visual-network">
      <span className={`md-network-plane${nodes.length > 7 ? ' is-dense' : ''}`}>
        <svg viewBox={`0 0 ${NET.width} ${NET.height}`} aria-hidden="true">
          {lines.map((line, index) => (
            <g key={index} className={stepClass(index, step).trim() || undefined}>
              <path className="md-network-link" d={line.d} />
              {line.heads.map((head, at) => (
                <path
                  key={at}
                  className="md-network-head"
                  d="M-2.6 -2L2.6 0L-2.6 2z"
                  transform={`translate(${head.x} ${head.y}) rotate(${head.angle})`}
                />
              ))}
            </g>
          ))}
        </svg>
        {nodes.map((node, index) => (
          <span
            key={index}
            className={`md-visual-box md-network-node${nodeClass(index)}`}
            style={{ left: left(points[index].x), top: top(points[index].y) }}
          >
            <span className="md-visual-title">{node}</span>
          </span>
        ))}
        {lines.map((line, index) =>
          edges[index].label ? (
            <span
              key={index}
              className={`md-network-label${stepClass(index, step)}`}
              style={{ left: left(line.label.x), top: top(line.label.y) }}
            >
              {edges[index].label}
            </span>
          ) : null
        )}
      </span>
      {/* Narrow cards cannot fit the plane; this list replaces it there (see markdown.css). */}
      <span className="md-network-list">
        {edges.map((edge, index) => (
          <span key={index} className={`md-network-row${stepClass(index, step)}`}>
            <span className="md-visual-title">
              {nodes[edge.from]} {LINK_MARK[edge.direction]} {nodes[edge.to]}
            </span>
            {edge.label ? <span className="md-visual-detail">{edge.label}</span> : null}
          </span>
        ))}
      </span>
    </span>
  )
}

/* ---- Graph ---- */

const PLOT = { w: 400, h: 250, left: 34, right: 10, top: 10, bottom: 22 }
const SAMPLES = 400
const DEFAULT_X: [number, number] = [-5, 5]

/** 1, 2 or 5 times a power of ten, giving about `count` steps over `span`. */
function niceStep(span: number, count: number): number {
  const raw = span / count
  const power = Math.pow(10, Math.floor(Math.log10(raw)))
  const scaled = raw / power
  return (scaled < 1.5 ? 1 : scaled < 3.5 ? 2 : scaled < 7.5 ? 5 : 10) * power
}

function ticks([low, high]: [number, number], count: number): number[] {
  const step = niceStep(high - low, count)
  const first = Math.ceil(low / step) * step
  const values: number[] = []
  for (let value = first; value <= high + step / 1e6; value += step) {
    values.push(Math.abs(value) < step / 1e6 ? 0 : value)
  }
  return values
}

function formatTick(value: number): string {
  return Number(value.toPrecision(4)).toString()
}

/** Steady digits for the slider's span, so the number does not jitter in width as it plays. */
function formatParameter(value: number, param: GraphParam): string {
  const span = param.max - param.min
  return value.toFixed(span >= 100 ? 0 : span >= 10 ? 1 : 2)
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
}

/**
 * Every combination of each parameter's ends and start. The view is fitted to all of them
 * once, so it stands still while a slider moves and the curve is what changes.
 */
function parameterCorners(params: GraphParam[]): Vars[] {
  return params.reduce<Vars[]>(
    (corners, param) =>
      corners.flatMap((vars) =>
        [param.min, param.start, param.max].map((value) => ({ ...vars, [param.name]: value }))
      ),
    [{}]
  )
}

function xDomain(graph: Graph, corners: Vars[]): [number, number] {
  if (graph.xRange) return graph.xRange
  const marks = corners
    .flatMap((vars) => [
      ...graph.points.map((p) => p.x(NaN, vars)),
      ...graph.verticals.map((v) => v.x(NaN, vars))
    ])
    .filter((x) => Number.isFinite(x))
  if (marks.length === 0) return DEFAULT_X
  const low = Math.min(DEFAULT_X[0], ...marks.map((x) => x - 1))
  const high = Math.max(DEFAULT_X[1], ...marks.map((x) => x + 1))
  return [low, high]
}

/** Fitted to the curves, ignoring the extreme 2% each way so an asymptote cannot flatten them. */
function yDomain(graph: Graph, xs: number[], corners: Vars[]): [number, number] {
  if (graph.yRange) return graph.yRange
  // Fewer samples per corner when there are many, so a graph with sliders costs about the same.
  const sampled = corners.length > 1 ? xs.filter((_, index) => index % 4 === 0) : xs
  const values = corners
    .flatMap((vars) => graph.curves.flatMap((curve) => sampled.map((x) => curve.fn(x, vars))))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
  const marks = corners
    .flatMap((vars) => graph.points.map((p) => p.y(NaN, vars)))
    .filter((y) => Number.isFinite(y))
  const low = Math.min(...(values.length ? [quantile(values, 0.02)] : []), ...marks)
  const high = Math.max(...(values.length ? [quantile(values, 0.98)] : []), ...marks)
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [-5, 5]
  const span = high - low || Math.max(1, Math.abs(high))
  return [low - span * 0.1, high + span * 0.1]
}

function graphView(graph: Graph): { xs: number[]; x: [number, number]; y: [number, number] } {
  const corners = parameterCorners(graph.params)
  const x = xDomain(graph, corners)
  const xs = Array.from({ length: SAMPLES + 1 }, (_, i) => x[0] + ((x[1] - x[0]) * i) / SAMPLES)
  return { xs, x, y: yDomain(graph, xs, corners) }
}

/** One sweep of a playing slider from end to end. */
const SWEEP_MS = 3500

/** 0 → 1 → 0 as `phase` goes 0 → 1 → 2, and round again. */
function triangle(phase: number): number {
  const turn = ((phase % 2) + 2) % 2
  return turn <= 1 ? turn : 2 - turn
}

interface Playing {
  name: string
  /** Where on the way up the slider stood when play was pressed, from 0 to 1. */
  from: number
}

/** The sliders' values: where the reader left each, or where it starts. */
function useParameters(params: GraphParam[]): {
  values: Vars
  playing: string | null
  set: (name: string, value: number) => void
  togglePlay: (param: GraphParam) => void
} {
  const [moved, setMoved] = useState<Vars>({})
  const [playing, setPlaying] = useState<Playing | null>(null)
  const values = useMemo(() => {
    const start = startValues(params)
    return Object.fromEntries(
      params.map((param) => [
        param.name,
        Math.min(param.max, Math.max(param.min, moved[param.name] ?? start[param.name]))
      ])
    )
  }, [params, moved])

  useEffect(() => {
    const param = playing && params.find((candidate) => candidate.name === playing.name)
    if (!playing || !param) return
    let frame = 0
    let began: number | null = null
    const tick = (now: number): void => {
      began ??= now
      const along = triangle(playing.from + (now - began) / SWEEP_MS)
      setMoved((current) => ({
        ...current,
        [param.name]: param.min + along * (param.max - param.min)
      }))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, params])

  return {
    values,
    playing: playing?.name ?? null,
    set: (name, value) => {
      setPlaying(null)
      setMoved((current) => ({ ...current, [name]: value }))
    },
    togglePlay: (param) => {
      if (playing?.name === param.name) return setPlaying(null)
      // From the top, `triangle` leads back down.
      setPlaying({
        name: param.name,
        from: (values[param.name] - param.min) / (param.max - param.min)
      })
    }
  }
}

function GraphView({ graph }: { graph: Graph }): React.JSX.Element {
  const clipId = `md-graph-clip-${useId().replace(/:/g, '')}`
  const view = useMemo(() => graphView(graph), [graph])
  const parameters = useParameters(graph.params)
  const vars = parameters.values
  const { xs } = view
  const [x0, x1] = view.x
  const [y0, y1] = view.y
  const plotW = PLOT.w - PLOT.left - PLOT.right
  const plotH = PLOT.h - PLOT.top - PLOT.bottom
  const sx = (x: number): number => PLOT.left + ((x - x0) / (x1 - x0)) * plotW
  const sy = (y: number): number => PLOT.top + ((y1 - y) / (y1 - y0)) * plotH
  const span = y1 - y0
  const paths = graph.curves.map((curve) => {
    let d = ''
    let pen = false
    let last = NaN
    for (const x of xs) {
      const y = curve.fn(x, vars)
      // Off far beyond the view, or a jump across it: an asymptote, so the pen lifts.
      const usable = Number.isFinite(y) && y > y0 - span * 3 && y < y1 + span * 3
      if (!usable || (pen && Math.abs(y - last) > span * 1.5)) {
        pen = false
        if (!usable) continue
      }
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(2)} ${sy(y).toFixed(2)}`
      pen = true
      last = y
    }
    return d
  })
  const axisX = y0 <= 0 && y1 >= 0 ? sy(0) : PLOT.top + plotH
  const axisY = x0 <= 0 && x1 >= 0 ? sx(0) : PLOT.left
  return (
    <span className="md-visual-graph">
      <svg viewBox={`0 0 ${PLOT.w} ${PLOT.h}`} role="img" aria-label="Graph">
        <defs>
          <clipPath id={clipId}>
            <rect x={PLOT.left} y={PLOT.top} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        {ticks([x0, x1], 8).map((x) => (
          <g key={`x${x}`}>
            <line
              className="md-graph-grid"
              x1={sx(x)}
              x2={sx(x)}
              y1={PLOT.top}
              y2={PLOT.top + plotH}
            />
            <text className="md-graph-tick" x={sx(x)} y={PLOT.h - 8} textAnchor="middle">
              {formatTick(x)}
            </text>
          </g>
        ))}
        {ticks([y0, y1], 6).map((y) => (
          <g key={`y${y}`}>
            <line
              className="md-graph-grid"
              x1={PLOT.left}
              x2={PLOT.left + plotW}
              y1={sy(y)}
              y2={sy(y)}
            />
            <text className="md-graph-tick" x={PLOT.left - 4} y={sy(y) + 3} textAnchor="end">
              {formatTick(y)}
            </text>
          </g>
        ))}
        <line
          className="md-graph-axis"
          x1={PLOT.left}
          x2={PLOT.left + plotW}
          y1={axisX}
          y2={axisX}
        />
        <line className="md-graph-axis" x1={axisY} x2={axisY} y1={PLOT.top} y2={PLOT.top + plotH} />
        <g clipPath={`url(#${clipId})`}>
          {graph.verticals.map((line, index) => (
            <line
              key={index}
              className="md-graph-vertical"
              x1={sx(line.x(NaN, vars))}
              x2={sx(line.x(NaN, vars))}
              y1={PLOT.top}
              y2={PLOT.top + plotH}
            />
          ))}
          {paths.map((d, index) => (
            <path key={index} className={`md-graph-curve md-graph-series-${index}`} d={d} />
          ))}
          {graph.points.map((point, index) => {
            const x = sx(point.x(NaN, vars))
            const y = sy(point.y(NaN, vars))
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null
            return (
              <g key={index}>
                <circle className="md-graph-point" cx={x} cy={y} r={3.5} />
                {point.label ? (
                  <text className="md-graph-label" x={x + 6} y={y - 6}>
                    {point.label}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
      {graph.curves.length + graph.verticals.length > 0 ? (
        <span className="md-graph-legend">
          {graph.curves.map((curve, index) => (
            <span key={index} className={`md-graph-key md-graph-series-${index}`}>
              {curve.label}
            </span>
          ))}
          {graph.verticals.map((line, index) => (
            <span key={`v${index}`} className="md-graph-key md-graph-key--vertical">
              {line.label}
            </span>
          ))}
        </span>
      ) : null}
      {graph.params.map((param) => {
        const value = vars[param.name]
        const isPlaying = parameters.playing === param.name
        return (
          <span key={param.name} className="md-graph-param">
            <button
              type="button"
              className="md-visual-control"
              title={isPlaying ? 'Pause' : `Play ${param.name} back and forth`}
              onClick={() => parameters.togglePlay(param)}
            >
              <Icon name={isPlaying ? 'pause' : 'play'} />
            </button>
            <span className="md-graph-param-value">
              {param.name} = {formatParameter(value, param)}
            </span>
            <input
              type="range"
              className="md-graph-slider"
              aria-label={`Value of ${param.name}`}
              min={param.min}
              max={param.max}
              step="any"
              value={value}
              onChange={(e) => parameters.set(param.name, Number(e.target.value))}
            />
          </span>
        )
      })}
    </span>
  )
}

/** The bars of every frame under one scale, in the order their labels first appear. */
function chartRows(frames: ChartFrame[]): { labels: string[]; largest: number } {
  const labels = [...new Set(frames.flatMap((frame) => frame.bars.map((bar) => bar.label)))]
  const values = frames.flatMap((frame) => frame.bars.map((bar) => Math.abs(bar.value)))
  return { labels, largest: Math.max(...values) || 1 }
}

function Chart({ title, frames }: { title?: string; frames: ChartFrame[] }): React.JSX.Element {
  const { labels, largest } = useMemo(() => chartRows(frames), [frames])
  return (
    <Stepped count={frames.length} rest={false} label={(step) => frames[step]?.heading ?? ''}>
      {(step) => {
        const frame = frames[step ?? 0] ?? frames[0]
        return (
          <span className="md-visual-chart">
            {title ? <span className="md-visual-title">{title}</span> : null}
            {labels.map((label) => {
              const value = frame.bars.find((bar) => bar.label === label)?.value
              return (
                <span key={label} className="md-chart-row">
                  <span className="md-chart-label">{label}</span>
                  <span className="md-chart-track">
                    <span
                      className={`md-chart-bar${(value ?? 0) < 0 ? ' is-negative' : ''}`}
                      style={{ width: `${(Math.abs(value ?? 0) / largest) * 100}%` }}
                    />
                  </span>
                  <span className="md-chart-value">
                    {value === undefined ? '–' : value.toLocaleString()}
                  </span>
                </span>
              )
            })}
          </span>
        )
      }}
    </Stepped>
  )
}

/* ---- Trace ---- */

function Trace({ head, frames }: { head?: string[]; frames: TraceFrame[] }): React.JSX.Element {
  const columns = Math.max(
    head?.length ?? 0,
    ...frames.flatMap((frame) => frame.rows.map((row) => row.length))
  )
  return (
    <Stepped count={frames.length} rest={false}>
      {(step) => {
        const frame = frames[step ?? 0] ?? frames[0]
        return (
          <span className="md-visual-trace">
            <span
              className="md-trace-grid"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(2.4em, auto))` }}
            >
              {head
                ? Array.from({ length: columns }, (_, column) => (
                    <span key={`h${column}`} className="md-trace-head">
                      {head[column] ?? ''}
                    </span>
                  ))
                : null}
              {frame.rows.flatMap((row, r) =>
                Array.from({ length: columns }, (_, c) => {
                  const cell = row[c]
                  return (
                    <span
                      key={`${r}-${c}`}
                      className={`md-trace-cell${cell?.marked ? ' is-marked' : ''}`}
                    >
                      {/* Keyed by its text, so a value that changes arrives with a flash. */}
                      <span key={cell?.text ?? ''} className="md-trace-value">
                        {cell?.text ?? ''}
                      </span>
                    </span>
                  )
                })
              )}
            </span>
            {frame.caption ? <span className="md-trace-caption">{frame.caption}</span> : null}
          </span>
        )
      }}
    </Stepped>
  )
}

function VisualBody({ visual }: { visual: Visual }): React.JSX.Element {
  switch (visual.kind) {
    case 'flow':
      return (
        <Stepped count={visual.items.length} rest>
          {(step) => <Flow items={visual.items} step={step} />}
        </Stepped>
      )
    case 'cycle':
      return (
        <Stepped count={visual.items.length} rest>
          {(step) => <Cycle items={visual.items} step={step} />}
        </Stepped>
      )
    case 'network':
      return (
        <Stepped count={visual.edges.length} rest>
          {(step) => <Network nodes={visual.nodes} edges={visual.edges} step={step} />}
        </Stepped>
      )
    case 'timeline':
      return (
        <Stepped count={visual.items.length} rest>
          {(step) => <Timeline items={visual.items} step={step} />}
        </Stepped>
      )
    case 'tree':
      return <Tree roots={visual.roots} />
    case 'venn':
      return <Venn sections={visual.sections} />
    case 'matrix':
      return <Matrix sections={visual.sections} x={visual.x} y={visual.y} />
    case 'graph':
      return <GraphView graph={visual} />
    case 'chart':
      return <Chart title={visual.title} frames={visual.frames} />
    case 'trace':
      return <Trace head={visual.head} frames={visual.frames} />
  }
}

function VisualBlock(props: VisualBlockProps): React.JSX.Element {
  const kind = props['data-kind'] as VisualBlockKind
  const source = props['data-source'] ?? ''
  const visual = useMemo(() => parseVisual(kind, source), [kind, source])
  const [showText, setShowText] = useState(false)
  const asText = showText || visual === null

  return (
    <span
      className={`md-visual md-visual--${kind}`}
      data-atom-start={props['data-atom-start']}
      data-atom-end={props['data-atom-end']}
    >
      {asText ? <span className="md-visual-source">{source}</span> : <VisualBody visual={visual} />}
      {visual ? (
        <button
          type="button"
          className="md-visual-toggle"
          title={showText ? 'Show the diagram' : 'Show the text it was drawn from'}
          onClick={() => setShowText((open) => !open)}
        >
          {showText ? 'Diagram' : 'Text'}
        </button>
      ) : null}
    </span>
  )
}

export default VisualBlock
