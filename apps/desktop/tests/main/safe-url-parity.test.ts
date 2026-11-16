import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { safeHref } from '@delta/ui/lib/safe-url'
import { isSafeExternalUrl } from '../../src/main/window-guards'

// The renderer may only draw a link that main will actually open (AGENTS.md, "Links open in the
// system browser"), so the two checks must answer alike for every href a model could write.
const HREFS = [
  'https://example.com',
  'http://example.com/path?q=1#frag',
  'HTTPS://EXAMPLE.COM',
  'HtTp://example.com',
  '  https://example.com  ',
  'https://user:pass@example.com:8080/',
  'http://localhost:3000',
  'http://192.168.0.1',
  'https://例え.jp',
  'http:example.com',
  'https:',
  'https://',
  'http://',
  'http:// spaced.com',
  'http://exa mple.com',
  'https://[::1]/',
  'https://[bad/',
  'httpsx://example.com',
  'mailto:someone@example.com',
  'javascript:alert(1)',
  ' javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
  'ftp://example.com',
  'blob:https://example.com/123',
  'about:blank',
  'chrome://settings',
  'vbscript:msgbox(1)',
  '//example.com',
  '/relative/path',
  '#anchor',
  'example.com',
  'www.example.com',
  ''
]

describe('safeHref and isSafeExternalUrl', () => {
  it.each(HREFS)('agree on %j', (href) => {
    const linked = safeHref(href) !== undefined
    expect(linked).toBe(isSafeExternalUrl(href.trim()))
  })

  it('agree when main receives exactly the href the renderer kept', () => {
    for (const href of HREFS) {
      const kept = safeHref(href)
      if (kept !== undefined) expect(isSafeExternalUrl(kept)).toBe(true)
    }
  })

  it('draw no link for a missing href', () => {
    expect(safeHref(undefined)).toBeUndefined()
  })
})
