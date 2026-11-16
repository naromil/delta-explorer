/**
 * Model output and page addresses are untrusted: only absolute web URLs may become links.
 * Parses the same way as `isSafeExternalUrl` in the desktop's `window-guards.ts`, the check that
 * actually opens a link, so a link is never drawn that main would refuse (a parity test holds them together).
 */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const value = href.trim()
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}
