/** Matches `isSafeExternalUrl` in the desktop's `window-guards.ts`, the check that actually opens a link. */
const SAFE_PROTOCOL = /^https?:/i

/** Model output and page addresses are untrusted: only absolute web URLs may become links. */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const value = href.trim()
  return SAFE_PROTOCOL.test(value) ? value : undefined
}
