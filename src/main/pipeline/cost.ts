import type { PricingConfig } from '@shared/types'

export function openaiCost(pricing: PricingConfig, model: string | null, inputTokens: number, outputTokens: number): number {
  const key = model ? bestModelKey(pricing, model) : 'default'
  const p = pricing.openai[key] ?? pricing.openai.default ?? { input: 0, output: 0 }
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
}

/** Finds the longest pricing key that prefixes the model id (gpt-5-mini-2026-01 → gpt-5-mini). */
export function bestModelKey(pricing: PricingConfig, model: string): string {
  let best = 'default'
  for (const key of Object.keys(pricing.openai)) {
    if (key === 'default') continue
    if (model === key || model.startsWith(key + '-') || model.startsWith(key)) {
      if (key.length > best.length || best === 'default') best = key
    }
  }
  return best
}

export function elevenCost(pricing: PricingConfig, characters: number): number {
  return (characters / 1000) * pricing.elevenlabsPer1kChars
}

/** Rough per-job estimate used for batch warnings before anything is spent. */
export function estimateJobCost(
  pricing: PricingConfig,
  opts: { model: string; expectedChars: number; research: boolean; reviewPass: boolean; audio: boolean }
): { openai: number; eleven: number; characters: number } {
  const scriptTokensOut = Math.ceil(opts.expectedChars / 4) + 200
  const scriptTokensIn = 2500 + (opts.research ? 1500 : 0)
  let openai = openaiCost(pricing, opts.model, scriptTokensIn, scriptTokensOut)
  if (opts.research) openai += openaiCost(pricing, opts.model, 4000, 1200) + 0.01 // web search tool call overhead (estimate)
  if (opts.reviewPass) openai += openaiCost(pricing, opts.model, scriptTokensIn + scriptTokensOut, 400)
  const characters = opts.audio ? opts.expectedChars : 0
  return { openai, eleven: opts.audio ? elevenCost(pricing, characters) : 0, characters }
}
