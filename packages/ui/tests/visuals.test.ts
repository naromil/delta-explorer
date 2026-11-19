import { describe, expect, it } from 'vitest'
import { VISUAL_BLOCK_SYNTAX } from '@delta/core/prompts'
import type { VisualBlockKind } from '@delta/core/prompts'
import { isVisualLanguage, parseVisual, splitItem } from '../src/lib/visuals'

/** The example in each syntax note, as the model would copy it. */
function example(kind: VisualBlockKind): string {
  const match = new RegExp('```' + kind + '\\n([\\s\\S]*?)```').exec(VISUAL_BLOCK_SYNTAX[kind])
  return match?.[1] ?? ''
}

describe('diagram blocks', () => {
  it('know their languages and nothing else', () => {
    expect(isVisualLanguage('flow')).toBe(true)
    expect(isVisualLanguage('matrix')).toBe(true)
    expect(isVisualLanguage('python')).toBe(false)
    expect(isVisualLanguage('toString')).toBe(false)
    expect(isVisualLanguage(undefined)).toBe(false)
  })

  it('split a title from its detail only at a colon and a space', () => {
    expect(splitItem('Water split: releases oxygen')).toEqual({
      title: 'Water split',
      detail: 'releases oxygen'
    })
    expect(splitItem('10:30 meeting')).toEqual({ title: '10:30 meeting' })
    expect(splitItem('- **Step one**')).toEqual({ title: 'Step one' })
    expect(splitItem('   ')).toBeNull()
  })

  it('draw every example the model is taught', () => {
    for (const kind of Object.keys(VISUAL_BLOCK_SYNTAX) as VisualBlockKind[]) {
      expect(parseVisual(kind, example(kind)), kind).not.toBeNull()
    }
  })

  it('read a flow as steps in order', () => {
    const visual = parseVisual('flow', example('flow'))
    expect(visual?.kind === 'flow' && visual.items.map((item) => item.title)).toEqual([
      'Light absorbed',
      'Water split',
      'Sugar built'
    ])
  })

  it('nest a tree by indentation', () => {
    const visual = parseVisual('tree', example('tree'))
    if (visual?.kind !== 'tree') throw new Error('not a tree')
    const [cell] = visual.roots
    expect(cell.title).toBe('Cell')
    expect(cell.children.map((child) => child.title)).toEqual(['Nucleus', 'Cytoplasm', 'Membrane'])
    expect(cell.children[1].children.map((child) => child.title)).toEqual([
      'Mitochondria',
      'Ribosomes'
    ])
  })

  it('read a matrix with its axes and four quadrants', () => {
    const visual = parseVisual('matrix', example('matrix'))
    if (visual?.kind !== 'matrix') throw new Error('not a matrix')
    expect(visual.x).toEqual(['urgent', 'not urgent'])
    expect(visual.y).toEqual(['unimportant', 'important'])
    expect(visual.sections.map((section) => section.heading)).toEqual([
      'Do now',
      'Schedule',
      'Delegate',
      'Drop'
    ])
  })

  it('read a venn as left, right and shared', () => {
    const visual = parseVisual('venn', example('venn'))
    if (visual?.kind !== 'venn') throw new Error('not a venn')
    expect(visual.sections.map((section) => section.items)).toEqual([
      ['two identical cells'],
      ['four varied cells'],
      ['copy DNA first']
    ])
  })

  it('draw what has arrived while a block is still streaming, and nothing before', () => {
    expect(parseVisual('cycle', '')).toBeNull()
    const partial = parseVisual('cycle', 'Evaporation: water turns to vap')
    expect(partial?.kind === 'cycle' && partial.items).toHaveLength(1)
  })

  it('read a graph: curves, a vertical line, the range and marked points', () => {
    const visual = parseVisual(
      'graph',
      'y = x^2 - 2\nf(x) = 2x + 1\nx = 1\nx: -4 | 4\npoint: (0, -2) vertex\nthis is not math'
    )
    if (visual?.kind !== 'graph') throw new Error('not a graph')
    expect(visual.curves.map((curve) => curve.label)).toEqual(['y = x^2 - 2', 'f(x) = 2x + 1'])
    expect(visual.curves[0].fn(3)).toBe(7)
    expect(visual.verticals.map((line) => [line.x(NaN), line.label])).toEqual([[1, 'x = 1']])
    expect(visual.xRange).toEqual([-4, 4])
    expect(visual.points.map((p) => [p.x(NaN), p.y(NaN), p.label])).toEqual([[0, -2, 'vertex']])
    expect(visual.params).toEqual([])
  })

  it('read a graph parameter as a slider that curves, lines and points may use', () => {
    const visual = parseVisual(
      'graph',
      'y = a*sin(x) + k\nx = t\npoint: (t, a*sin(t)) here\na: 0 | 3 | 2\nt: -6 | 6\nk: 2 | 4\nx: -8 | 8\ne: 0 | 1'
    )
    if (visual?.kind !== 'graph') throw new Error('not a graph')
    // A parameter may be declared after the line that uses it; x, y and e are never one.
    expect(visual.params).toEqual([
      { name: 'a', min: 0, max: 3, start: 2 },
      { name: 't', min: -6, max: 6, start: 1 },
      { name: 'k', min: 2, max: 4, start: 3 }
    ])
    expect(visual.xRange).toEqual([-8, 8])
    const vars = { a: 2, t: Math.PI / 2, k: 1 }
    expect(visual.curves[0].fn(Math.PI / 2, vars)).toBeCloseTo(3)
    expect(visual.verticals[0].x(NaN, vars)).toBeCloseTo(Math.PI / 2)
    expect(visual.points[0].y(NaN, vars)).toBeCloseTo(2)
  })

  it('leave out a line that names a parameter nobody declared', () => {
    const visual = parseVisual('graph', 'y = b*x\ny = x')
    expect(visual?.kind === 'graph' && visual.curves.map((curve) => curve.label)).toEqual(['y = x'])
  })

  it('read a chart: its title and one bar per line', () => {
    const visual = parseVisual('chart', 'title: Population\nCanada: 40,100,000\nIceland: 0.39')
    expect(visual).toEqual({
      kind: 'chart',
      title: 'Population',
      frames: [
        {
          heading: '',
          bars: [
            { label: 'Canada', value: 40100000 },
            { label: 'Iceland', value: 0.39 }
          ]
        }
      ]
    })
  })

  it('read a chart with headings as frames, dropping one with no bars yet', () => {
    const visual = parseVisual('chart', '[1990]\nA: 1\nB: 2\n[2020]\nA: 3\n[2050]')
    if (visual?.kind !== 'chart') throw new Error('not a chart')
    expect(visual.frames.map((frame) => [frame.heading, frame.bars.length])).toEqual([
      ['1990', 2],
      ['2020', 1]
    ])
  })

  it('read a trace: a frame per caption, marked cells, and cells that hold spaces', () => {
    const visual = parseVisual('trace', example('trace'))
    if (visual?.kind !== 'trace') throw new Error('not a trace')
    expect(visual.frames).toHaveLength(4)
    expect(visual.frames[2].caption).toBe('Swap them')
    expect(visual.frames[2].rows).toEqual([
      [
        { text: '2', marked: true },
        { text: '5', marked: true },
        { text: '8', marked: false },
        { text: '1', marked: false }
      ]
    ])
    const table = parseVisual(
      'trace',
      'head: | R | r\n|---|---|---|\n| R | RR* | Rr |\nr | Rr | r r'
    )
    if (table?.kind !== 'trace') throw new Error('not a trace')
    expect(table.head).toEqual(['', 'R', 'r'])
    expect(table.frames).toHaveLength(1)
    expect(table.frames[0].rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['R', 'RR', 'Rr'],
      ['r', 'Rr', 'r r']
    ])
    expect(table.frames[0].rows[0][1].marked).toBe(true)
  })

  it('keeps a trace row of dashes standing for empty cells', () => {
    const filling = parseVisual('trace', '[Start: nothing filled]\n- - -\n[Fill the first]\n1* - -')
    if (filling?.kind !== 'trace') throw new Error('not a trace')
    expect(filling.frames.map((frame) => frame.caption)).toEqual([
      'Start: nothing filled',
      'Fill the first'
    ])
    expect(filling.frames[0].rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['-', '-', '-']
    ])
    const piped = parseVisual('trace', '| a | b |\n|:--|--:|\n| - | - |')
    if (piped?.kind !== 'trace') throw new Error('not a trace')
    expect(piped.frames[0].rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['a', 'b'],
      ['-', '-']
    ])
  })

  it('read a network: links, chains, directions and a label that holds a dash', () => {
    const visual = parseVisual(
      'network',
      'Idle -> Running: start -- now\nrunning <-> Paused\nPaused -- Idle -> Done\nAlone\nIdle ->'
    )
    if (visual?.kind !== 'network') throw new Error('not a network')
    expect(visual.nodes).toEqual(['Idle', 'Running', 'Paused', 'Done', 'Alone'])
    expect(visual.edges).toEqual([
      { from: 0, to: 1, direction: 'forward', label: 'start -- now' },
      { from: 1, to: 2, direction: 'both' },
      { from: 2, to: 0, direction: 'none' },
      { from: 0, to: 3, direction: 'forward' }
    ])
  })
})
