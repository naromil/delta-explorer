/**
 * Diagrams written as fenced blocks (`flow`, `cycle`, `timeline`, `tree`, `venn`, `matrix`),
 * read line by line so a block still streaming draws what has arrived. The syntax the model
 * is taught lives in `VISUAL_BLOCK_SYNTAX` (`@delta/core/prompts`); keep the two in step.
 */
import type { VisualBlockKind } from '@delta/core/prompts'
import { VISUAL_BLOCK_SYNTAX } from '@delta/core/prompts'
import type { Fn } from './math-expression'
import { compileExpression } from './math-expression'

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

export interface GraphPoint {
  x: number
  y: number
  label: string
}

export interface Graph {
  kind: 'graph'
  curves: GraphCurve[]
  /** `x = 2`: a vertical line, such as an asymptote. */
  verticals: Array<{ x: number; label: string }>
  points: GraphPoint[]
  xRange?: [number, number]
  yRange?: [number, number]
}

export interface ChartBar {
  label: string
  value: number
}

export type Visual =
  | Graph
  | { kind: 'chart'; title?: string; bars: ChartBar[] }
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

/** A number written as an expression without x (`-2`, `pi/2`, `sqrt(2)`). */
function constant(text: string): number | null {
  const fn = compileExpression(text)
  const value = fn ? fn(0) : NaN
  return Number.isFinite(value) ? value : null
}

function range(text: string): [number, number] | undefined {
  const [low, high] = text.split('|').map((part) => constant(part))
  return low !== null && high !== null && low !== undefined && high !== undefined && high > low
    ? [low, high]
    : undefined
}

/** Lines that do not read are skipped, so a line still streaming in costs nothing. */
function parseGraph(source: string): Graph | null {
  const graph: Graph = { kind: 'graph', curves: [], verticals: [], points: [] }
  for (const raw of lines(source)) {
    const line = raw.trim()
    const rangeLine = /^([xy])\s*:\s*(.+\|.+)$/i.exec(line)
    const point = /^point\s*:\s*\(([^,]+),([^)]+)\)\s*(.*)$/i.exec(line)
    if (rangeLine) {
      const value = range(rangeLine[2])
      if (rangeLine[1].toLowerCase() === 'x') graph.xRange = value
      else graph.yRange = value
    } else if (point) {
      const x = constant(point[1])
      const y = constant(point[2])
      if (x !== null && y !== null) graph.points.push({ x, y, label: plain(point[3]) })
    } else {
      const equals = line.lastIndexOf('=')
      const left = equals < 0 ? 'y' : line.slice(0, equals).trim()
      const right = equals < 0 ? line : line.slice(equals + 1).trim()
      if (left.toLowerCase() === 'x') {
        const x = constant(right)
        if (x !== null) graph.verticals.push({ x, label: `x = ${right}` })
        continue
      }
      const fn = compileExpression(right)
      if (!fn || graph.curves.length >= GRAPH_CURVE_LIMIT) continue
      graph.curves.push({ label: `${left} = ${right}`, fn })
    }
  }
  return graph.curves.length + graph.points.length + graph.verticals.length > 0 ? graph : null
}

function parseChart(source: string): Visual | null {
  let title: string | undefined
  const bars: ChartBar[] = []
  for (const line of lines(source)) {
    const titled = /^\s*title\s*:\s*(.+)$/i.exec(line)
    if (titled && bars.length === 0) {
      title = plain(titled[1])
      continue
    }
    const bar = /^(.+):\s*(-?[\d,]*\.?\d+)/.exec(plain(line))
    if (!bar) continue
    const value = Number(bar[2].replace(/,/g, ''))
    if (Number.isFinite(value)) bars.push({ label: bar[1].trim(), value })
  }
  return bars.length > 0 ? { kind: 'chart', bars, ...(title ? { title } : {}) } : null
}

/** The diagram in `source`, or null when nothing in it can be drawn yet. */
export function parseVisual(kind: VisualBlockKind, source: string): Visual | null {
  if (kind === 'graph') return parseGraph(source)
  if (kind === 'chart') return parseChart(source)
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
