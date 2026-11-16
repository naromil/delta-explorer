import { describe, expect, it } from 'vitest'
import { compileExpression } from '../src/lib/math-expression'

function at(source: string, x: number): number {
  const fn = compileExpression(source)
  if (!fn) throw new Error(`could not read ${source}`)
  return fn(x)
}

describe('compileExpression', () => {
  it('follows the usual precedence', () => {
    expect(at('1 + 2 * 3', 0)).toBe(7)
    expect(at('2^3^2', 0)).toBe(512)
    expect(at('-x^2', 3)).toBe(-9)
    expect(at('(1 + x) / 2', 3)).toBe(2)
  })

  it('reads implicit multiplication as written in textbooks', () => {
    expect(at('2x + 1', 3)).toBe(7)
    expect(at('3(x + 1)', 1)).toBe(6)
    expect(at('x sin(x)', Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    expect(at('2pi', 0)).toBeCloseTo(2 * Math.PI)
  })

  it('knows functions, constants and common symbols', () => {
    expect(at('sqrt(x)', 9)).toBe(3)
    expect(at('ln(e)', 0)).toBeCloseTo(1)
    expect(at('log(100)', 0)).toBeCloseTo(2)
    expect(at('sinh(0) + exp(0)', 0)).toBe(1)
    expect(at('sin^2(x) + cos^2(x)', 1.2)).toBeCloseTo(1)
    expect(at('x² − 1', 3)).toBe(8)
    expect(at('√x', 4)).toBe(2)
    expect(at('abs(x)', -2)).toBe(2)
  })

  it('refuses anything else, so nothing is ever run as code', () => {
    expect(compileExpression('alert(1)')).toBeNull()
    expect(compileExpression('x +')).toBeNull()
    expect(compileExpression('(x')).toBeNull()
    expect(compileExpression('y')).toBeNull()
    expect(compileExpression('')).toBeNull()
  })
})
