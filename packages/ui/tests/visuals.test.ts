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
    expect(visual.verticals).toEqual([{ x: 1, label: 'x = 1' }])
    expect(visual.xRange).toEqual([-4, 4])
    expect(visual.points).toEqual([{ x: 0, y: -2, label: 'vertex' }])
  })

  it('read a chart: its title and one bar per line', () => {
    const visual = parseVisual('chart', 'title: Population\nCanada: 40,100,000\nIceland: 0.39')
    expect(visual).toEqual({
      kind: 'chart',
      title: 'Population',
      bars: [
        { label: 'Canada', value: 40100000 },
        { label: 'Iceland', value: 0.39 }
      ]
    })
  })
})
