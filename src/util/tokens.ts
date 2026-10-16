/**
 * Approximate token count. The spec names token budgets but no tokenizer.
 * v1 uses the common 4 characters ≈ 1 token estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
