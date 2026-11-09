import { describe, expect, it } from 'vitest'
import { renderMath } from '../../src/renderer/src/lib/math'

describe('renderMath', () => {
  it('renders TeX to KaTeX markup, inline and as a display block', () => {
    const inline = renderMath('x^2', false)
    expect(inline).toContain('class="katex"')
    expect(inline).not.toContain('katex-display')
    expect(renderMath('x^2', true)).toContain('katex-display')
  })

  // trust: false is the only safeguard on the renderer's one dangerouslySetInnerHTML.
  it.each([
    ['\\href{javascript:alert(1)}{click}'],
    ['\\href{https://example.com}{click}'],
    ['\\url{https://example.com}']
  ])('never produces a link from %s', (tex) => {
    const html = renderMath(tex, false)
    expect(html).not.toMatch(/<a[\s>]/i)
    // The source survives only as the MathML annotation's text, never as an attribute.
    expect(html).not.toMatch(/href=/i)
  })

  it.each([
    ['\\includegraphics{https://example.com/x.png}', /<img[\s>]/i],
    ['\\htmlClass{evil}{x}', /class="evil"/],
    ['\\htmlId{evil}{x}', /id="evil"/],
    ['\\htmlStyle{color:red}{x}', /style="color:red"/],
    ['\\htmlData{foo=bar}{x}', /data-foo=/]
  ])('refuses %s instead of emitting its HTML', (tex, forbidden) => {
    expect(renderMath(tex, false)).not.toMatch(forbidden)
  })

  it('renders bad TeX as an inline error instead of throwing', () => {
    let html = ''
    expect(() => {
      html = renderMath('\\frac{1}{', false)
    }).not.toThrow()
    expect(html).toContain('katex-error')
  })

  it('escapes raw HTML in the source', () => {
    const html = renderMath('\\text{<script>alert(1)</script>}', false)
    expect(html).not.toContain('<script>')
  })
})
