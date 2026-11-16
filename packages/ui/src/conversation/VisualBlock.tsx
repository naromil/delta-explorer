import { useId, useMemo, useState } from 'react'
import type { VisualBlockKind } from '@delta/core/prompts'
import type {
  ChartBar,
  Graph,
  Visual,
  VisualItem,
  VisualSection,
  VisualTreeNode
} from '../lib/visuals'
import { parseVisual } from '../lib/visuals'

/**
 * A diagram drawn from a fenced block. Everything is a span, because inside an expansion frame
 * the markdown host is itself a span; CSS gives them their boxes. The block is one selection
 * atom, like the code block it replaces, and "Text" shows the source it was drawn from.
 */

interface VisualBlockProps {
  'data-kind'?: string
  'data-source'?: string
  'data-atom-start'?: number
  'data-atom-end'?: number
}

function ItemText({ item }: { item: VisualItem }): React.JSX.Element {
  return (
    <>
      <span className="md-visual-title">{item.title}</span>
      {item.detail ? <span className="md-visual-detail">{item.detail}</span> : null}
    </>
  )
}

function Flow({ items }: { items: VisualItem[] }): React.JSX.Element {
  return (
    <span className="md-visual-flow">
      {items.map((item, index) => (
        <span key={index} className="md-visual-step">
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
function Cycle({ items }: { items: VisualItem[] }): React.JSX.Element {
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
            <path key={index} d={d} markerEnd={`url(#${markerId})`} />
          ))}
        </svg>
        {items.map((item, index) => {
          const point = ringPoint(angleOf(index))
          return (
            <span
              key={index}
              className="md-visual-box md-visual-stage"
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
            >
              <ItemText item={item} />
            </span>
          )
        })}
      </span>
      {/* Narrow cards cannot fit a ring; this list replaces it there (see markdown.css). */}
      <span className="md-visual-cycle-list">
        <Flow items={items} />
        <span className="md-visual-repeat">↻ then back to {items[0]?.title}</span>
      </span>
    </span>
  )
}

function Timeline({ items }: { items: VisualItem[] }): React.JSX.Element {
  return (
    <span className="md-visual-timeline">
      {items.map((item, index) => (
        <span key={index} className="md-visual-event">
          <span className="md-visual-dot" aria-hidden="true" />
          <span className="md-visual-when">{item.title}</span>
          {item.detail ? <span className="md-visual-detail">{item.detail}</span> : null}
        </span>
      ))}
    </span>
  )
}

function TreeNode({ node, depth }: { node: VisualTreeNode; depth: number }): React.JSX.Element {
  return (
    <span className={`md-visual-node${depth === 0 ? ' is-root' : ''}`}>
      <span className="md-visual-box">
        <ItemText item={node} />
      </span>
      {node.children.length > 0 ? (
        <span className="md-visual-children">
          {node.children.map((child, index) => (
            <TreeNode key={index} node={child} depth={depth + 1} />
          ))}
        </span>
      ) : null}
    </span>
  )
}

function Tree({ roots }: { roots: VisualTreeNode[] }): React.JSX.Element {
  return (
    <span className="md-visual-tree">
      {roots.map((root, index) => (
        <TreeNode key={index} node={root} depth={0} />
      ))}
    </span>
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

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
}

function xDomain(graph: Graph): [number, number] {
  if (graph.xRange) return graph.xRange
  const marks = [...graph.points.map((p) => p.x), ...graph.verticals.map((v) => v.x)]
  if (marks.length === 0) return DEFAULT_X
  const low = Math.min(DEFAULT_X[0], ...marks.map((x) => x - 1))
  const high = Math.max(DEFAULT_X[1], ...marks.map((x) => x + 1))
  return [low, high]
}

/** Fitted to the curves, ignoring the extreme 2% each way so an asymptote cannot flatten them. */
function yDomain(graph: Graph, xs: number[]): [number, number] {
  if (graph.yRange) return graph.yRange
  const values = graph.curves
    .flatMap((curve) => xs.map((x) => curve.fn(x)))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
  const marks = graph.points.map((p) => p.y)
  const low = Math.min(...(values.length ? [quantile(values, 0.02)] : []), ...marks)
  const high = Math.max(...(values.length ? [quantile(values, 0.98)] : []), ...marks)
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [-5, 5]
  const span = high - low || Math.max(1, Math.abs(high))
  return [low - span * 0.1, high + span * 0.1]
}

function GraphView({ graph }: { graph: Graph }): React.JSX.Element {
  const clipId = `md-graph-clip-${useId().replace(/:/g, '')}`
  const [x0, x1] = xDomain(graph)
  const xs = Array.from({ length: SAMPLES + 1 }, (_, i) => x0 + ((x1 - x0) * i) / SAMPLES)
  const [y0, y1] = yDomain(graph, xs)
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
      const y = curve.fn(x)
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
              x1={sx(line.x)}
              x2={sx(line.x)}
              y1={PLOT.top}
              y2={PLOT.top + plotH}
            />
          ))}
          {paths.map((d, index) => (
            <path key={index} className={`md-graph-curve md-graph-series-${index}`} d={d} />
          ))}
          {graph.points.map((point, index) => (
            <g key={index}>
              <circle className="md-graph-point" cx={sx(point.x)} cy={sy(point.y)} r={3.5} />
              {point.label ? (
                <text className="md-graph-label" x={sx(point.x) + 6} y={sy(point.y) - 6}>
                  {point.label}
                </text>
              ) : null}
            </g>
          ))}
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
    </span>
  )
}

function Chart({ title, bars }: { title?: string; bars: ChartBar[] }): React.JSX.Element {
  const largest = Math.max(...bars.map((bar) => Math.abs(bar.value))) || 1
  return (
    <span className="md-visual-chart">
      {title ? <span className="md-visual-title">{title}</span> : null}
      {bars.map((bar, index) => (
        <span key={index} className="md-chart-row">
          <span className="md-chart-label">{bar.label}</span>
          <span className="md-chart-track">
            <span
              className={`md-chart-bar${bar.value < 0 ? ' is-negative' : ''}`}
              style={{ width: `${(Math.abs(bar.value) / largest) * 100}%` }}
            />
          </span>
          <span className="md-chart-value">{bar.value.toLocaleString()}</span>
        </span>
      ))}
    </span>
  )
}

function VisualBody({ visual }: { visual: Visual }): React.JSX.Element {
  switch (visual.kind) {
    case 'flow':
      return <Flow items={visual.items} />
    case 'cycle':
      return <Cycle items={visual.items} />
    case 'timeline':
      return <Timeline items={visual.items} />
    case 'tree':
      return <Tree roots={visual.roots} />
    case 'venn':
      return <Venn sections={visual.sections} />
    case 'matrix':
      return <Matrix sections={visual.sections} x={visual.x} y={visual.y} />
    case 'graph':
      return <GraphView graph={visual} />
    case 'chart':
      return <Chart title={visual.title} bars={visual.bars} />
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
