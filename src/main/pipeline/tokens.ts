/**
 * Output-token caps (1.6.1). OpenAI counts every request against the model's tokens-per-minute
 * limit at (input + max_output_tokens) when it arrives, so a generous cap costs throughput even
 * when the model writes far less. Caps are sized to what the request needs; if a model still runs
 * out, the request is retried once with the full limit (visible in the job's history).
 */

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high'

/** Reasoning tokens also count against max_output_tokens. */
export const REASONING_HEADROOM: Record<ReasoningEffort, number> = { none: 200, minimal: 300, low: 600, medium: 1500, high: 3000 }

/** English narration is ≈ 4 characters per token; 3.2 leaves ~25 % headroom for longer words and labels. */
export const SCRIPT_CHARS_PER_TOKEN = 3.2

/** Research JSON is ~600–900 tokens with low reasoning. */
export const RESEARCH_OUTPUT_TOKENS = 1500

/** Research cap outside the queue, and the one-time fallback when the small cap runs out. */
export const RESEARCH_FULL_OUTPUT_TOKENS = 5000

/** Rough input allowance for web-search results at the 'low' search context size. */
export const WEB_SEARCH_INPUT_TOKENS = 3000

export function scriptOutputTokens(maxChars: number, effort: ReasoningEffort | string | undefined, settingsMax: number): number {
  const headroom = REASONING_HEADROOM[(effort ?? 'low') as ReasoningEffort] ?? REASONING_HEADROOM.low
  const need = Math.ceil((maxChars > 0 ? maxChars : 5000) / SCRIPT_CHARS_PER_TOKEN) + headroom
  return Math.max(256, Math.min(settingsMax, need))
}

/** The 1.6.0 formula, kept for the comparison in the CHANGELOG and tests. */
export function legacyScriptOutputTokens(maxChars: number, settingsMax: number): number {
  return Math.min(settingsMax, Math.max(2500, Math.ceil(((maxChars || 5000) * 2) / 3.5) + 1500))
}

/** Input tokens estimated from characters (OpenAI's own rule of thumb: ≈ 4 characters per token). */
export function inputTokens(...texts: Array<string | null | undefined>): number {
  let chars = 0
  for (const t of texts) chars += t?.length ?? 0
  return Math.ceil(chars / 4)
}
