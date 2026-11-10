/** A fresh id for one streaming request, unique within a session. */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
