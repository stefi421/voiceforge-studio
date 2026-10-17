import type {
  AppSettings,
  ChannelInput,
  PricingConfig,
  ResearchSettings,
  ScriptSection,
  TemplateVersionInput,
  ValidationRules,
  VoiceSettings
} from './types'

export const APP_NAME = 'VoiceForge Studio'

/**
 * Pricing defaults are ESTIMATES. They are editable in Settings → Usage & Costs
 * and must be checked against the provider's current price list. The UI always
 * labels derived numbers as estimates.
 */
export const DEFAULT_PRICING: PricingConfig = {
  openai: {
    default: { input: 2.5, output: 10 },
    'gpt-5': { input: 1.25, output: 10 },
    'gpt-5-mini': { input: 0.25, output: 2 },
    'gpt-5-nano': { input: 0.05, output: 0.4 },
    'gpt-4.1': { input: 2, output: 8 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 }
  },
  // Creator plan reference value; adjust to your plan in Settings.
  elevenlabsPer1kChars: 0.3,
  currency: 'USD'
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    theme: 'dark',
    language: 'en',
    launchAtStartup: false,
    notifications: true,
    outputRoot: null,
    autoOpenFolderOnBatchComplete: false
  },
  openai: {
    defaultModel: 'gpt-5',
    researchModel: 'gpt-5',
    reviewModel: 'gpt-5-mini',
    temperature: 0.7,
    maxOutputTokens: 8000,
    timeoutMs: 240000,
    maxRetries: 2,
    concurrency: 2,
    reasoningEffort: 'low'
  },
  elevenlabs: {
    defaultModelId: 'eleven_multilingual_v2',
    defaultOutputFormat: 'mp3_44100_128',
    timeoutMs: 300000,
    maxRetries: 2,
    concurrency: 1,
    maxCharsPerRequest: 0
  },
  generation: {
    defaultMode: 'auto',
    maxConcurrentJobs: 2,
    maxRewriteAttempts: 2,
    maxStageRetries: 3,
    validationStrictness: 'standard',
    duplicateDetection: true,
    largeBatchWarningThreshold: 20,
    confirmExpensiveRegeneration: true
  },
  spending: {
    dailyLimitUsd: null,
    monthlyLimitUsd: null,
    pricing: DEFAULT_PRICING
  },
  storage: {
    backupDir: null,
    autoBackupEveryHours: 24,
    keepBackups: 10,
    cleanupTempFiles: true
  },
  sync: {
    enabled: false,
    provider: 'none',
    status: 'not_configured'
  },
  advanced: {
    logLevel: 'info',
    manualE2EMode: false
  }
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1
}

export const DEFAULT_RESEARCH: ResearchSettings = {
  enabled: true,
  mode: 'openai_web_search',
  minConfidence: 0.6,
  searchContextSize: 'medium',
  askOnAmbiguity: true,
  extraInstructions: ''
}

export const DEFAULT_VALIDATION: ValidationRules = {
  forbidUrls: true,
  forbidCitations: true,
  forbidMarkdown: true,
  enforceSectionOrder: true,
  aiReviewPass: true,
  maxRewriteAttempts: 2,
  wordsPerMinute: 150,
  language: 'en',
  forbiddenPhrases: [],
  narrateSectionHeadings: true
}

export const JOB_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  researching: 'Researching',
  research_review_required: 'Research Review Required',
  writing_script: 'Writing Script',
  validating_script: 'Validating Script',
  script_ready: 'Script Ready',
  awaiting_approval: 'Awaiting Approval',
  generating_audio: 'Generating Audio',
  saving_files: 'Saving Files',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
  cancelled: 'Cancelled'
}

export const JOB_MODE_LABELS: Record<string, string> = {
  auto: 'Fully Automatic',
  review_before_voice: 'Review Before Voice',
  scripts_only: 'Scripts Only'
}

export const ELEVEN_OUTPUT_FORMATS = [
  'mp3_44100_128',
  'mp3_44100_192',
  'mp3_44100_96',
  'mp3_44100_64',
  'mp3_22050_32',
  'pcm_44100',
  'pcm_24000'
] as const

/** Well-known OpenAI models offered in the picker; the live list comes from the API. */
export const SUGGESTED_OPENAI_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini']

function section(key: string, label: string, guidance: string, aliases: string[] = [], required = true): ScriptSection {
  return { key, label, required, aliases, guidance }
}

interface SeedChannel {
  channel: ChannelInput
  templateName: string
  template: TemplateVersionInput
}

const commonRules = `General rules (apply to every script):
- Write natural spoken narration for a voiceover. No URLs, no links, no citation markers, no markdown, no bullet symbols, no emojis.
- Never invent firsthand experience: no "I played", "in my testing", FPS numbers, benchmark results or playtime unless they appear in the supplied research data as confirmed facts.
- Only use information from the supplied research data. If something is uncertain, phrase it carefully ("according to the developer", "is expected to") or leave it out.
- Write acronyms in lowercase (usb-c, qmk, via, ghz).
- Output ONLY the script text. Do not add a title line, notes or explanations.`

const PLACEHOLDER_NOTE =
  'PLACEHOLDER TEMPLATE — the approved template has not been supplied yet. Open Channels → this channel → Template Editor, paste the approved script and instructions, and create a new version. Generation is blocked while this placeholder is active.'

export const SEED_CHANNELS: SeedChannel[] = [
  {
    channel: {
      name: 'PlayTopia',
      icon: '🎮',
      color: '#7C5CFF',
      description: 'Gaming review channel. English scripts with a fixed approved structure, max 4,700 characters.',
      category: 'gaming',
      language: 'en',
      writingInstructions:
        'English gaming review. Fixed approved structure with a consistent introduction and conclusion. Natural spoken narration. No URLs, no citations, no formatting, no invented gameplay experiences.',
      writingStyle: 'Natural, energetic spoken review narration.',
      introRequirements: 'Consistent introduction (to be taken from the approved template).',
      outroRequirements: 'Consistent conclusion (to be taken from the approved template).',
      targetDurationSec: 270,
      minChars: 3800,
      maxChars: 4700,
      pronunciationRules: [],
      elevenVoiceId: null,
      elevenVoiceName: null,
      elevenModelId: 'eleven_multilingual_v2',
      elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
      outputFormat: 'mp3_44100_128',
      outputFolder: null,
      openaiModel: null,
      research: DEFAULT_RESEARCH,
      validation: { ...DEFAULT_VALIDATION, forbiddenPhrases: [] },
      archived: false
    },
    templateName: 'PlayTopia review (awaiting approved template)',
    template: {
      systemPrompt: `${PLACEHOLDER_NOTE}\n\n${commonRules}`,
      structure: [],
      exampleScript: null,
      notes: 'Placeholder created at first launch. Replace with the approved PlayTopia template.',
      placeholder: true
    }
  },
  {
    channel: {
      name: 'Game Vault',
      icon: '🗝️',
      color: '#2DD4BF',
      description: 'Gaming review channel. Gameplay → Combat / Combat & Exploration → Pros → Cons → Conclusion. 4–5 minutes.',
      category: 'gaming',
      language: 'en',
      writingInstructions:
        'English gaming review of about 4–5 minutes of narration. Required section order: Gameplay; Combat (or Combat & Exploration); Pros; Cons; Conclusion. Keep Pros and Cons as separate sections. Natural review style. No URLs. Never use the term "AAA". Accurate information about the game only.',
      writingStyle: 'Natural, knowledgeable review narration that breaks down the mechanics that matter.',
      introRequirements:
        'Open with the fixed intro: "Welcome back to Game Vault, where we mine the hidden gems and dive into the big releases—breaking down the mechanics that matter."',
      outroRequirements: 'Close with a clear conclusion/verdict in the Conclusion section.',
      targetDurationSec: 270,
      minChars: 3500,
      maxChars: 4500,
      pronunciationRules: [],
      elevenVoiceId: null,
      elevenVoiceName: null,
      elevenModelId: 'eleven_multilingual_v2',
      elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
      outputFormat: 'mp3_44100_128',
      outputFolder: null,
      openaiModel: null,
      research: DEFAULT_RESEARCH,
      validation: { ...DEFAULT_VALIDATION, forbiddenPhrases: ['AAA'] },
      archived: false
    },
    templateName: 'Game Vault review',
    template: {
      systemPrompt: `You write voiceover scripts for the YouTube channel Game Vault, a gaming review channel.

Structure (plain-text section labels on their own line, exactly in this order):
Gameplay
Combat (or "Combat & Exploration" when exploration is a major part of the game)
Pros
Cons
Conclusion

Rules specific to Game Vault:
- Start the script with this exact intro sentence: "Welcome back to Game Vault, where we mine the hidden gems and dive into the big releases—breaking down the mechanics that matter."
- Keep Pros and Cons as two separate sections.
- Never use the term "AAA".
- Target 4 to 5 minutes of narration (about 3,500–4,500 characters).
- Natural review style focused on mechanics; accurate information only.

${commonRules}`,
      structure: [
        section('gameplay', 'Gameplay', 'Core loop, what the player does, pacing, progression.'),
        section('combat', 'Combat', 'Combat systems; use "Combat & Exploration" when exploration is central.', ['Combat & Exploration', 'Combat and Exploration']),
        section('pros', 'Pros', 'Strengths, kept separate from Cons.'),
        section('cons', 'Cons', 'Weaknesses, kept separate from Pros.'),
        section('conclusion', 'Conclusion', 'Verdict and who the game is for.')
      ],
      exampleScript: null,
      notes: 'Initial version built from the stated Game Vault rules (fixed intro, section order, no "AAA", 4–5 minutes). Add an approved example script for closer style matching.',
      placeholder: false
    }
  },
  {
    channel: {
      name: 'VoidPulse',
      icon: '🌀',
      color: '#F472B6',
      description: 'Gaming review channel with its own distinctive narration identity. Approved format pending.',
      category: 'gaming',
      language: 'en',
      writingInstructions:
        'English gaming review with a distinctive narration style and an independent structure (not copied from other channels). Consistent formatting across scripts. No URLs.',
      writingStyle: 'Distinctive VoidPulse voice (to be defined by the approved template).',
      introRequirements: '',
      outroRequirements: '',
      targetDurationSec: 270,
      minChars: 3500,
      maxChars: 4700,
      pronunciationRules: [],
      elevenVoiceId: null,
      elevenVoiceName: null,
      elevenModelId: 'eleven_multilingual_v2',
      elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
      outputFormat: 'mp3_44100_128',
      outputFolder: null,
      openaiModel: null,
      research: DEFAULT_RESEARCH,
      validation: DEFAULT_VALIDATION,
      archived: false
    },
    templateName: 'VoidPulse review (awaiting approved format)',
    template: {
      systemPrompt: `${PLACEHOLDER_NOTE}\n\n${commonRules}`,
      structure: [],
      exampleScript: null,
      notes: 'Placeholder created at first launch. Replace with the approved VoidPulse format.',
      placeholder: true
    }
  },
  {
    channel: {
      name: 'RiftForge Tech',
      icon: '⚙️',
      color: '#F59E0B',
      description: 'Technology reviews, unboxings and shorter voiceover formats. Accurate specifications, no invented benchmarks or hands-on claims.',
      category: 'tech',
      language: 'en',
      writingInstructions:
        'English product-focused technology review. Use accurate technical specifications from the research data only. Natural narration. No invented benchmark results, no invented hands-on testing, no URLs. Clearly distinguish specifications from actual testing.',
      writingStyle: 'Clear, product-focused tech narration.',
      introRequirements: '',
      outroRequirements: '',
      targetDurationSec: 240,
      minChars: 2500,
      maxChars: 4500,
      pronunciationRules: [],
      elevenVoiceId: null,
      elevenVoiceName: null,
      elevenModelId: 'eleven_multilingual_v2',
      elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
      outputFormat: 'mp3_44100_128',
      outputFolder: null,
      openaiModel: null,
      research: { ...DEFAULT_RESEARCH, extraInstructions: 'Prioritize the manufacturer product page and official documentation for specifications.' },
      validation: DEFAULT_VALIDATION,
      archived: false
    },
    templateName: 'RiftForge Tech product review',
    template: {
      systemPrompt: `You write voiceover scripts for the YouTube channel RiftForge Tech, a technology review channel covering product reviews, unboxings and shorter voiceover formats.

Rules specific to RiftForge Tech:
- Product-focused review built on accurate technical specifications from the supplied research data.
- Never invent benchmark results, measurements or hands-on testing. When describing performance, attribute it ("the manufacturer states", "rated for") unless the research marks it as confirmed testing.
- Distinguish specifications from actual testing.
- Natural narration a presenter can read in one take.

${commonRules}`,
      structure: [
        section('introduction', 'Introduction', 'What the product is and who it is for.', ['Intro']),
        section('design', 'Design & Build', 'Materials, dimensions, ports, layout.', ['Design', 'Build Quality', 'Build Quality & Design']),
        section('features', 'Features & Specs', 'Key specifications and features from the research data.', ['Features', 'Specifications', 'Specs']),
        section('verdict', 'Verdict', 'Who should buy it and why.', ['Final Verdict', 'Conclusion'])
      ],
      exampleScript: null,
      notes: 'Initial version built from the stated RiftForge Tech rules. Section labels are a reasonable default and can be customized.',
      placeholder: false
    }
  },
  {
    channel: {
      name: 'RENVO',
      icon: '💠',
      color: '#38BDF8',
      description: 'Premium technology review channel. Introduction → Unboxing → Build Quality & Design → Features → Performance & Testing → Pros & Cons → Final Verdict.',
      category: 'tech',
      language: 'en',
      writingInstructions:
        'Premium English technology review. Default section order: Introduction; Unboxing; Build Quality & Design; Features; Performance & Testing; Pros & Cons; Final Verdict. Accurate specifications only; do not invent test results. No URLs.',
      writingStyle: 'Premium, polished, confident tech review narration.',
      introRequirements: '',
      outroRequirements: '',
      targetDurationSec: 300,
      minChars: 3500,
      maxChars: 4800,
      pronunciationRules: [],
      elevenVoiceId: null,
      elevenVoiceName: null,
      elevenModelId: 'eleven_multilingual_v2',
      elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
      outputFormat: 'mp3_44100_128',
      outputFolder: null,
      openaiModel: null,
      research: { ...DEFAULT_RESEARCH, extraInstructions: 'Prioritize the manufacturer product page and official documentation for specifications.' },
      validation: DEFAULT_VALIDATION,
      archived: false
    },
    templateName: 'RENVO review (awaiting approved template)',
    template: {
      systemPrompt: `${PLACEHOLDER_NOTE}\n\nDefault RENVO section order (customizable): Introduction; Unboxing; Build Quality & Design; Features; Performance & Testing; Pros & Cons; Final Verdict.\n\n${commonRules}`,
      structure: [
        section('introduction', 'Introduction', 'What the product is and why it matters.'),
        section('unboxing', 'Unboxing', 'Packaging, box contents, first impressions.'),
        section('build', 'Build Quality & Design', 'Materials, finish, ergonomics.'),
        section('features', 'Features', 'Key features and specifications.'),
        section('performance', 'Performance & Testing', 'Only confirmed data; label manufacturer claims as such.'),
        section('proscons', 'Pros & Cons', 'Balanced strengths and weaknesses.'),
        section('verdict', 'Final Verdict', 'Recommendation and who it suits.')
      ],
      exampleScript: null,
      notes: 'Placeholder created at first launch with the default RENVO section order. Replace with the approved RENVO template.',
      placeholder: true
    }
  }
]
