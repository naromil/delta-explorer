/**
 * Diagrams written as fenced blocks (`flow`, `cycle`, `timeline`, `tree`, `venn`, `matrix`,
 * `graph`, `chart`, `trace`, `network`), read line by line so a block still streaming draws what has
 * arrived. The syntax the model is taught lives in `VISUAL_BLOCK_SYNTAX`
 * (`@delta/core/prompts`); keep the two in step.
 *
 * Several of them are scenes that move, and say how declaratively: the order of a flow's
 * lines is the order it plays in, a graph's parameters are sliders, and a chart or trace
 * with `[Heading]` frames is stepped from one to the next.
 */
import type { VisualBlockKind } from '@delta/core/prompts'
import { VISUAL_BLOCK_SYNTAX } from '@delta/core/prompts'
import type { Fn, Vars } from './math-expression'
import { compileExpression, isParameterName } from './math-expression'

export interface VisualItem {
  title: string
  detail?: string
}

export interface VisualTreeNode extends VisualItem {
  children: VisualTreeNode[]
}

export interface VisualSection {
  heading: string
  items: string[]
}

export interface GraphCurve {
  label: string
  fn: Fn
}

/** Its coordinates may use the graph's parameters, so a point can move along a curve. */
export interface GraphPoint {
  x: Fn
  y: Fn
  label: string
}

/** `a: 0 | 5 | 1`: a value the reader slides between `min` and `max`, starting at `start`. */
export interface GraphParam {
  name: string
  min: number
  max: number
  start: number
}

export interface Graph {
  kind: 'graph'
  curves: GraphCurve[]
  /** `x = 2`: a vertical line, such as an asymptote. */
  verticals: Array<{ x: Fn; label: string }>
  points: GraphPoint[]
  params: GraphParam[]
  xRange?: [number, number]
  yRange?: [number, number]
}

export interface ChartBar {
  label: string
  value: number
}

/** One state of a chart; a chart with several is stepped through them. */
export interface ChartFrame {
  heading: string
  bars: ChartBar[]
}

export interface TraceCell {
  text: string
  marked: boolean
}

/** One state of a trace: its rows of cells and what happened to reach it. */
export interface TraceFrame {
  caption: string
  rows: TraceCell[][]
}

/** `forward` is an arrow from `from` to `to`, `both` one each way, `none` a plain line. */
export interface NetworkEdge {
  from: number
  to: number
  direction: 'forward' | 'both' | 'none'
  label?: string
}

export type Visual =
  | Graph
  | { kind: 'network'; nodes: string[]; edges: NetworkEdge[] }
  | { kind: 'chart'; title?: string; frames: ChartFrame[] }
  | { kind: 'trace'; head?: string[]; frames: TraceFrame[] }
  | { kind: 'flow' | 'cycle' | 'timeline'; items: VisualItem[] }
  | { kind: 'tree'; roots: VisualTreeNode[] }
  | { kind: 'venn'; sections: VisualSection[] }
  | { kind: 'matrix'; sections: VisualSection[]; x?: [string, string]; y?: [string, string] }

export function isVisualLanguage(language: string | undefined): language is VisualBlockKind {
  return language !== undefined && Object.hasOwn(VISUAL_BLOCK_SYNTAX, language)
}

/** Markdown the model slipped in anyway: emphasis and code marks, and a leading list marker. */
function plain(text: string): string {
  return text
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `Title: detail`; a colon must be followed by a space, so `10:30` stays a title. */
export function splitItem(line: string): VisualItem | null {
  const text = plain(line)
  if (text === '') return null
  const match = /^(.+?):\s+(.+)$/.exec(text)
  if (!match) return { title: text.replace(/:$/, '') }
  return { title: match[1].trim(), detail: match[2].trim() }
}

function lines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => line.trim() !== '')
}

function parseItems(source: string): VisualItem[] {
  return lines(source).flatMap((line) => splitItem(line) ?? [])
}

function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
  return lead.replace(/\t/g, '  ').length
}

/** Nodes nest by indentation; a deeper line belongs to the nearest shallower one above it. */
function parseTree(source: string): VisualTreeNode[] {
  const roots: VisualTreeNode[] = []
  const stack: Array<{ indent: number; node: VisualTreeNode }> = []
  for (const line of lines(source)) {
    const item = splitItem(line)
    if (!item) continue
    const node: VisualTreeNode = { ...item, children: [] }
    const indent = indentOf(line)
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)
    stack.push({ indent, node })
  }
  return roots
}

function axis(value: string): [string, string] | undefined {
  const [low, high] = value.split('|').map((part) => plain(part))
  return low && high ? [low, high] : undefined
}

function parseSections(source: string): {
  sections: VisualSection[]
  x?: [string, string]
  y?: [string, string]
} {
  const sections: VisualSection[] = []
  let x: [string, string] | undefined
  let y: [string, string] | undefined
  for (const line of lines(source)) {
    const heading = /^\s*\[(.+)\]\s*$/.exec(line)
    const axisLine = /^\s*([xy])\s*:\s*(.+\|.+)$/i.exec(line)
    if (heading) {
      sections.push({ heading: plain(heading[1]), items: [] })
    } else if (axisLine && sections.length === 0) {
      if (axisLine[1].toLowerCase() === 'x') x = axis(axisLine[2])
      else y = axis(axisLine[2])
    } else {
      const text = plain(line)
      if (text === '') continue
      if (sections.length === 0) sections.push({ heading: '', items: [] })
      sections[sections.length - 1].items.push(text)
    }
  }
  return { sections, ...(x ? { x } : {}), ...(y ? { y } : {}) }
}

const GRAPH_CURVE_LIMIT = 4
const GRAPH_PARAM_LIMIT = 3

/** A number written as an expression without x (`-2`, `pi/2`, `sqrt(2)`). */
function constant(text: string): number | null {
  const fn = compileExpression(text)
  const value = fn ? fn(0) : NaN
  return Number.isFinite(value) ? value : null
}

/** The values every parameter starts at. */
export function startValues(params: GraphParam[]): Vars {
  return Object.fromEntries(params.map((param) => [param.name, param.start]))
}

/** `a: 0 | 5` or `a: 0 | 5 | 1`; anything else on the line is not a parameter. */
function parseParam(line: string): GraphParam | null {
  const match = /^([a-z])\s*:\s*(.+\|.+)$/i.exec(line)
  const name = match?.[1].toLowerCase()
  if (!match || !name || !isParameterName(name)) return null
  const [min, max, start] = match[2].split('|').map((part) => constant(part))
  if (min === null || max === null || min === undefined || max === undefined || max <= min) {
    return null
  }
  const first = start ?? (min <= 1 && max >= 1 ? 1 : (min + max) / 2)
  return { name, min, max, start: Math.min(max, Math.max(min, first)) }
}

function range(text: string): [number, number] | undefined {
  const [low, high] = text.split('|').map((part) => constant(part))
  return low !== null && high !== null && low !== undefined && high !== undefined && high > low
    ? [low, high]
    : undefined
}

/**
 * `point: (x, y) label`, split at the comma and the bracket that close the pair rather than
 * the first ones, since a coordinate may be `a*sin(t)`.
 */
function parsePoint(line: string): { x: string; y: string; label: string } | null {
  const open = /^point\s*:\s*\(/i.exec(line)
  if (!open) return null
  let depth = 1
  let comma = -1
  for (let i = open[0].length; i < line.length; i += 1) {
    const char = line[i]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 1 && comma < 0) comma = i
    if (depth > 0) continue
    if (comma < 0) return null
    return {
      x: line.slice(open[0].length, comma),
      y: line.slice(comma + 1, i),
      label: line.slice(i + 1)
    }
  }
  return null
}

/** Lines that do not read are skipped, so a line still streaming in costs nothing. */
function parseGraph(source: string): Graph | null {
  const graph: Graph = { kind: 'graph', curves: [], verticals: [], points: [], params: [] }
  const rest: string[] = []
  // Parameters first: a curve may use one declared on a later line.
  for (const raw of lines(source)) {
    const param = parseParam(raw.trim())
    if (!param) rest.push(raw.trim())
    else if (
      graph.params.length < GRAPH_PARAM_LIMIT &&
      !graph.params.some((known) => known.name === param.name)
    ) {
      graph.params.push(param)
    }
  }
  const names = graph.params.map((param) => param.name)
  const start = startValues(graph.params)
  /** An expression of the parameters alone, which must be a number where they start. */
  const placed = (text: string): Fn | null => {
    const fn = compileExpression(text, names)
    return fn && Number.isFinite(fn(NaN, start)) ? fn : null
  }
  for (const line of rest) {
    const rangeLine = /^([xy])\s*:\s*(.+\|.+)$/i.exec(line)
    const point = parsePoint(line)
    if (rangeLine) {
      const value = range(rangeLine[2])
      if (rangeLine[1].toLowerCase() === 'x') graph.xRange = value
      else graph.yRange = value
    } else if (point) {
      const x = placed(point.x)
      const y = placed(point.y)
      if (x && y) graph.points.push({ x, y, label: plain(point.label) })
    } else {
      const equals = line.lastIndexOf('=')
      const left = equals < 0 ? 'y' : line.slice(0, equals).trim()
      const right = equals < 0 ? line : line.slice(equals + 1).trim()
      if (left.toLowerCase() === 'x') {
        const x = placed(right)
        if (x) graph.verticals.push({ x, label: `x = ${right}` })
        continue
      }
      const fn = compileExpression(right, names)
      if (!fn || graph.curves.length >= GRAPH_CURVE_LIMIT) continue
      graph.curves.push({ label: `${left} = ${right}`, fn })
    }
  }
  return graph.curves.length + graph.points.length + graph.verticals.length > 0 ? graph : null
}

const FRAME_HEADING = /^\s*\[(.+)\]\s*$/

/** Bars under `[Heading]` lines are frames of one chart; without any, it is a single frame. */
function parseChart(source: string): Visual | null {
  let title: string | undefined
  const frames: ChartFrame[] = []
  for (const line of lines(source)) {
    const titled = /^\s*title\s*:\s*(.+)$/i.exec(line)
    if (titled && frames.length === 0) {
      title = plain(titled[1])
      continue
    }
    const heading = FRAME_HEADING.exec(line)
    if (heading) {
      frames.push({ heading: plain(heading[1]), bars: [] })
      continue
    }
    const bar = /^(.+):\s*(-?[\d,]*\.?\d+)/.exec(plain(line))
    if (!bar) continue
    const value = Number(bar[2].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    if (frames.length === 0) frames.push({ heading: '', bars: [] })
    frames[frames.length - 1].bars.push({ label: bar[1].trim(), value })
  }
  const drawn = frames.filter((frame) => frame.bars.length > 0)
  return drawn.length > 0 ? { kind: 'chart', frames: drawn, ...(title ? { title } : {}) } : null
}

/**
 * Cells split at `|`, or at spaces when the row has none (`5 2 8 1`); a trailing `*` marks
 * the cell. A markdown table's outer pipes and its `---` rule are tolerated.
 */
function parseTraceRow(line: string): TraceCell[] {
  const text = line.replace(/`/g, '').trim()
  if (/^[\s|:-]+$/.test(text) && text.includes('-')) return []
  // Only a row fenced on both sides is a markdown row; `| R | r` starts with an empty cell.
  const fenced = text.length > 1 && text.startsWith('|') && text.endsWith('|')
  const parts = text.includes('|')
    ? (fenced ? text.slice(1, -1) : text).split('|').map((part) => part.trim())
    : text.split(/\s+/)
  return parts.map((part) => {
    const marked = /\*+$/.test(part) && part.replace(/\*+$/, '').trim() !== ''
    const value = marked ? part.replace(/\*+$/, '') : part
    return { text: value.replace(/\*\*/g, '').trim(), marked }
  })
}

/** Each `[What happened]` line starts a frame holding the whole state after it. */
function parseTrace(source: string): Visual | null {
  let head: string[] | undefined
  const frames: TraceFrame[] = []
  for (const line of lines(source)) {
    const heading = FRAME_HEADING.exec(line)
    const headLine = /^\s*head\s*:\s*(.+)$/i.exec(line)
    if (heading) {
      frames.push({ caption: plain(heading[1]), rows: [] })
    } else if (headLine && frames.length === 0) {
      head = parseTraceRow(headLine[1]).map((cell) => cell.text)
    } else {
      const row = parseTraceRow(line)
      if (row.length === 0) continue
      if (frames.length === 0) frames.push({ caption: '', rows: [] })
      frames[frames.length - 1].rows.push(row)
    }
  }
  const drawn = frames.filter((frame) => frame.rows.length > 0)
  return drawn.length > 0 ? { kind: 'trace', frames: drawn, ...(head ? { head } : {}) } : null
}

const NETWORK_NODE_LIMIT = 14
const NETWORK_EDGE_LIMIT = 24
const NETWORK_LINK = /\s*(<-+>|↔|-+>|→|--+|—)\s*/

function linkDirection(link: string): NetworkEdge['direction'] {
  if (link.startsWith('<') || link === '↔') return 'both'
  return link.endsWith('>') || link === '→' ? 'forward' : 'none'
}

/**
 * `A -> B: label`, one link per line or a chain (`A -> B -> C`), whose label belongs to its
 * last link. A line with no link is a node standing alone. Names match without regard to case.
 */
function parseNetwork(source: string): Visual | null {
  const nodes: string[] = []
  const edges: NetworkEdge[] = []
  const nodeIndex = (name: string): number => {
    const known = nodes.findIndex((node) => node.toLowerCase() === name.toLowerCase())
    if (known >= 0 || nodes.length >= NETWORK_NODE_LIMIT) return known
    return nodes.push(name) - 1
  }
  for (const line of lines(source)) {
    // The label is cut off first, so a dash or arrow inside it is not read as a link.
    const colon = line.search(/:(\s|$)/)
    const label = colon < 0 ? '' : plain(line.slice(colon + 1))
    const parts = (colon < 0 ? line : line.slice(0, colon)).split(NETWORK_LINK)
    const names = parts.filter((_, index) => index % 2 === 0).map((name) => plain(name))
    let from = names[0] ? nodeIndex(names[0]) : -1
    for (let index = 1; index < names.length; index += 1) {
      const to = names[index] ? nodeIndex(names[index]) : -1
      if (from >= 0 && to >= 0 && edges.length < NETWORK_EDGE_LIMIT) {
        edges.push({
          from,
          to,
          direction: linkDirection(parts[index * 2 - 1]),
          ...(label && index === names.length - 1 ? { label } : {})
        })
      }
      from = to
    }
  }
  return nodes.length > 0 ? { kind: 'network', nodes, edges } : null
}

/** The diagram in `source`, or null when nothing in it can be drawn yet. */
export function parseVisual(kind: VisualBlockKind, source: string): Visual | null {
  if (kind === 'graph') return parseGraph(source)
  if (kind === 'chart') return parseChart(source)
  if (kind === 'trace') return parseTrace(source)
  if (kind === 'network') return parseNetwork(source)
  if (kind === 'tree') {
    const roots = parseTree(source)
    return roots.length > 0 ? { kind, roots } : null
  }
  if (kind === 'venn' || kind === 'matrix') {
    const parsed = parseSections(source)
    if (parsed.sections.length === 0) return null
    if (kind === 'venn') return { kind, sections: parsed.sections.slice(0, 3) }
    return { kind, ...parsed, sections: parsed.sections.slice(0, 4) }
  }
  const items = parseItems(source)
  return items.length > 0 ? { kind, items } : null
}
