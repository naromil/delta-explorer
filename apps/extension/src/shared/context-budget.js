/* Pure token budgeting, ported from Delta Explorer's src/shared/context-budget.ts.
 * Requests drop their oldest messages when they would not fit the model's
 * window (as reported by models.dev); an unknown window trims nothing. */

/** Reserved for the reply when the caller does not know the model's output cap. */
export const DEFAULT_OUTPUT_RESERVE = 4096;

/** Flat allowance per image: providers bill by pixels, which the budget cannot see. */
export const IMAGE_TOKEN_ESTIMATE = 1500;

/** Rough estimate: 4 characters per token, never zero for real content. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessageTokens(message) {
  return estimateTokens(message.content) + (message.images ? message.images.length : 0) * IMAGE_TOKEN_ESTIMATE;
}

/** Input budget for a window, leaving room for the reply; `null` means do not trim. */
export function budgetFor(contextWindow, maxOutput) {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const requested = maxOutput !== undefined && Number.isFinite(maxOutput) && maxOutput > 0;
  const reserve = Math.min(requested ? maxOutput : DEFAULT_OUTPUT_RESERVE, Math.floor(contextWindow / 2));
  return Math.max(1024, Math.floor(contextWindow * 0.85) - reserve);
}

/** Drops the oldest non-system messages (never the final one) until the estimate fits. */
export function trimMessages(messages, budget) {
  const kept = [...messages];
  let dropped = 0;
  const total = () => kept.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  while (total() > budget) {
    const index = kept.findIndex((message, i) => i !== kept.length - 1 && message.role !== 'system');
    if (index === -1) break;
    kept.splice(index, 1);
    dropped++;
  }
  return { messages: kept, dropped };
}
