/** Whether an expansion could start; `reason` names why not, for a notice or a test. */
export type ExpandOutcome = { ok: true } | { ok: false; reason: string }
