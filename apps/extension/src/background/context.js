/* Fits a request into the model's context window, as reported by models.dev.
 * Fail-open: an unknown model or window trims nothing. */

import { budgetFor, trimMessages } from '../shared/context-budget.js';
import { getCachedModel } from './model-catalog.js';

export async function buildContextBudget(messages, target) {
  try {
    const model = await getCachedModel(target.providerType, target.model);
    const budget = budgetFor(model?.contextWindow, model?.maxOutput);
    if (budget === null) return messages;
    return trimMessages(messages, budget).messages;
  } catch {
    return messages;
  }
}
