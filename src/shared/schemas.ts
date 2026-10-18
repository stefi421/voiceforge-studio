import { z } from 'zod'

/**
 * Runtime validation schemas. Every IPC handler validates its input with one of
 * these before touching the database or a provider. The renderer also uses
 * them for form validation so the rules live in one place.
 */

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)

export const scriptSectionSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  aliases: z.array(z.string().max(120)).max(20),
  guidance: z.string().max(4000)
})

export const pronunciationRuleSchema = z.object({
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200)
})

export const voiceSettingsSchema = z.object({
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  useSpeakerBoost: z.boolean().optional(),
  speed: z.number().min(0.7).max(1.2).optional()
})

export const researchSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['openai_web_search', 'model_knowledge', 'manual']),
  minConfidence: z.number().min(0).max(1),
  searchContextSize: z.enum(['low', 'medium', 'high']),
  askOnAmbiguity: z.boolean(),
  extraInstructions: z.string().max(8000)
})

export const validationRulesSchema = z.object({
  forbidUrls: z.boolean(),
  forbidCitations: z.boolean(),
  forbidMarkdown: z.boolean(),
  enforceSectionOrder: z.boolean(),
  aiReviewPass: z.boolean(),
  maxRewriteAttempts: z.number().int().min(0).max(10),
  wordsPerMinute: z.number().int().min(80).max(260),
  language: z.string().min(2).max(10),
  forbiddenPhrases: z.array(z.string().max(200)).max(200),
  narrateSectionHeadings: z.boolean()
})

const channelInputBase = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().max(16),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  description: z.string().max(2000),
  category: z.enum(['gaming', 'tech', 'other']),
  language: z.string().min(2).max(10),
  writingInstructions: z.string().max(40000),
  writingStyle: z.string().max(4000),
  introRequirements: z.string().max(4000),
  outroRequirements: z.string().max(4000),
  targetDurationSec: z.number().int().min(10).max(3600),
  minChars: z.number().int().min(0).max(100000),
  maxChars: z.number().int().min(100).max(100000),
  pronunciationRules: z.array(pronunciationRuleSchema).max(500),
  elevenVoiceId: z.string().max(120).nullable(),
  elevenVoiceName: z.string().max(200).nullable(),
  elevenModelId: z.string().min(1).max(120),
  elevenVoiceSettings: voiceSettingsSchema,
  outputFormat: z.string().min(1).max(40),
  outputFolder: z.string().max(1024).nullable(),
  openaiModel: z.string().max(120).nullable(),
  research: researchSettingsSchema,
  validation: validationRulesSchema,
  activeTemplateVersionId: idSchema.nullable().optional(),
  position: z.number().int().min(0).optional(),
  archived: z.boolean()
})

export const channelInputSchema = channelInputBase.refine((c) => c.maxChars >= c.minChars, { message: 'maxChars must be >= minChars' })

export const channelPatchSchema = channelInputBase.partial().refine((c) => c.maxChars === undefined || c.minChars === undefined || c.maxChars >= c.minChars, {
  message: 'maxChars must be >= minChars'
})

export const templateVersionInputSchema = z.object({
  systemPrompt: z.string().max(60000),
  structure: z.array(scriptSectionSchema).max(40),
  exampleScript: z.string().max(60000).nullable(),
  notes: z.string().max(4000),
  placeholder: z.boolean().optional()
})

export const jobModeSchema = z.enum(['auto', 'review_before_voice', 'scripts_only'])

export const titleEntrySchema = z.object({
  title: z.string().trim().min(1).max(200),
  channelId: idSchema.nullable()
})

export const createBatchSchema = z.object({
  name: z.string().max(120).optional(),
  channelId: idSchema,
  mode: jobModeSchema,
  entries: z.array(titleEntrySchema).min(1).max(500),
  skipExisting: z.boolean(),
  manualResearchNotes: z.record(z.string(), z.string().max(20000)).optional()
})

export const jobFilterSchema = z.object({
  batchId: idSchema.optional(),
  channelId: idSchema.optional(),
  status: z.array(z.string()).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional()
})

export const libraryFilterSchema = z.object({
  channelId: idSchema.optional(),
  projectId: idSchema.optional(),
  search: z.string().max(200).optional(),
  status: z.string().max(40).optional(),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  offset: z.number().int().min(0).optional()
})

export const resolveResearchSchema = z.object({
  jobId: idSchema,
  candidateIndex: z.number().int().min(0).optional(),
  manualTitle: z.string().max(200).optional(),
  manualNotes: z.string().max(20000).optional()
})

export const regenerateAudioSchema = z.object({
  projectId: idSchema,
  scriptId: idSchema.optional(),
  voiceId: z.string().max(120).optional(),
  voiceName: z.string().max(200).optional(),
  modelId: z.string().max(120).optional(),
  voiceSettings: voiceSettingsSchema.optional(),
  confirmedCost: z.boolean().optional()
})

export const pricingSchema = z.object({
  openai: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })),
  elevenlabsPer1kChars: z.number().min(0),
  currency: z.literal('USD')
})

export const appSettingsSchema = z.object({
  general: z.object({
    theme: z.enum(['dark', 'light', 'system']),
    language: z.enum(['en', 'sr']),
    launchAtStartup: z.boolean(),
    notifications: z.boolean(),
    outputRoot: z.string().max(1024).nullable(),
    autoOpenFolderOnBatchComplete: z.boolean(),
    onboardingCompleted: z.boolean()
  }),
  openai: z.object({
    defaultModel: z.string().min(1).max(120),
    researchModel: z.string().min(1).max(120),
    reviewModel: z.string().min(1).max(120),
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().min(256).max(128000),
    timeoutMs: z.number().int().min(5000).max(900000),
    maxRetries: z.number().int().min(0).max(10),
    concurrency: z.number().int().min(1).max(10),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high'])
  }),
  elevenlabs: z.object({
    defaultModelId: z.string().min(1).max(120),
    defaultOutputFormat: z.string().min(1).max(40),
    timeoutMs: z.number().int().min(5000).max(900000),
    maxRetries: z.number().int().min(0).max(10),
    concurrency: z.number().int().min(1).max(5),
    maxCharsPerRequest: z.number().int().min(0).max(40000)
  }),
  generation: z.object({
    defaultMode: jobModeSchema,
    maxConcurrentJobs: z.number().int().min(1).max(20),
    maxRewriteAttempts: z.number().int().min(0).max(10),
    maxStageRetries: z.number().int().min(0).max(10),
    validationStrictness: z.enum(['relaxed', 'standard', 'strict']),
    lengthToleranceChars: z.number().int().min(0).max(2000),
    duplicateDetection: z.boolean(),
    largeBatchWarningThreshold: z.number().int().min(1).max(1000),
    confirmExpensiveRegeneration: z.boolean()
  }),
  spending: z.object({
    dailyLimitUsd: z.number().min(0).nullable(),
    monthlyLimitUsd: z.number().min(0).nullable(),
    pricing: pricingSchema
  }),
  storage: z.object({
    backupDir: z.string().max(1024).nullable(),
    autoBackupEveryHours: z.number().int().min(0).max(720),
    keepBackups: z.number().int().min(1).max(100),
    cleanupTempFiles: z.boolean()
  }),
  sync: z.object({
    enabled: z.boolean(),
    provider: z.enum(['none', 'supabase']),
    status: z.literal('not_configured')
  }),
  advanced: z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
    manualE2EMode: z.boolean()
  }),
  updates: z.object({
    checkOnStartup: z.boolean(),
    owner: z.string().max(100).regex(/^[A-Za-z0-9-]*$/),
    repo: z.string().max(100).regex(/^[A-Za-z0-9_.-]*$/),
    allowPrerelease: z.boolean()
  })
})

export const settingsPatchSchema = z.object({
  general: appSettingsSchema.shape.general.partial().optional(),
  openai: appSettingsSchema.shape.openai.partial().optional(),
  elevenlabs: appSettingsSchema.shape.elevenlabs.partial().optional(),
  generation: appSettingsSchema.shape.generation.partial().optional(),
  spending: appSettingsSchema.shape.spending.partial().optional(),
  storage: appSettingsSchema.shape.storage.partial().optional(),
  sync: appSettingsSchema.shape.sync.partial().optional(),
  advanced: appSettingsSchema.shape.advanced.partial().optional(),
  updates: appSettingsSchema.shape.updates.partial().optional()
})

export const providerSchema = z.enum(['openai', 'elevenlabs'])

export const secretSetSchema = z.object({
  provider: providerSchema,
  value: z.string().min(8).max(512)
})

export const pathSchema = z.string().min(1).max(2048)

export const analyzeTemplateSchema = z.object({
  channelId: idSchema,
  exampleScript: z.string().min(50).max(60000),
  instructions: z.string().max(20000)
})

export const usageRangeSchema = z.object({
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional()
})

export const exportKindSchema = z.enum(['configuration', 'channels', 'templates', 'projects', 'history', 'all'])

export const channelExportSchema = z.object({
  format: z.literal('voiceforge-channel'),
  version: z.literal(1),
  channel: channelInputBase,
  templates: z.array(
    z.object({
      name: z.string().min(1).max(120),
      versions: z.array(templateVersionInputSchema.extend({ version: z.number().int().min(1) })),
      activeVersion: z.number().int().min(1).nullable()
    })
  )
})

export type ChannelExport = z.infer<typeof channelExportSchema>
