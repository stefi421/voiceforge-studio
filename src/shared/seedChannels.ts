import type { ChannelInput, ScriptSection, TemplateApprovalStatus, TemplateVersionInput } from './types'
import { DEFAULT_RESEARCH, DEFAULT_VALIDATION, DEFAULT_VOICE_SETTINGS } from './defaults'

/**
 * Channel profiles from docs/channel-spec/CHANNEL_CONFIGURATION.md.
 *
 * Only what the spec states is configured. Everything it marks "NOT VERIFIED" /
 * "NOT YET IMPORTED" is listed under `unverified` and the format stays blocked
 * (`not_configured`) or supervised (`provisional`) until the owner imports
 * approved reference scripts and approves the extracted template. No intro,
 * outro or section name is invented here.
 *
 * Description/branding lines from YouTube descriptions are stored only in the
 * channel description, explicitly labelled, and never reach a writer prompt.
 */

export const SEED_MARKER = '[seed:v3]'

export interface SeedFormat {
  name: string
  contentType: string
  version: TemplateVersionInput & { approvalStatus: TemplateApprovalStatus }
}

export interface SeedChannelV3 {
  channel: ChannelInput
  formats: SeedFormat[]
}

function section(key: string, label: string, guidance: string, aliases: string[] = [], required = true): ScriptSection {
  return { key, label, required, aliases, guidance }
}

const PROVISIONAL_LENGTH = 'Length 4,000–5,000 characters is the provisional production default from the spec (not a verified rule for this channel).'

function ch(
  over: Pick<ChannelInput, 'name' | 'icon' | 'color' | 'description' | 'category'> & Partial<ChannelInput>
): ChannelInput {
  const tech = over.category === 'tech'
  return {
    language: 'en',
    writingInstructions: '',
    writingStyle: '',
    introRequirements: '',
    outroRequirements: '',
    targetDurationSec: 300,
    minChars: 4000,
    maxChars: 5000,
    pronunciationRules: [],
    elevenVoiceId: null,
    elevenVoiceName: null,
    elevenModelId: 'eleven_v4',
    elevenVoiceSettings: DEFAULT_VOICE_SETTINGS,
    outputFormat: 'mp3_44100_128',
    outputFolder: null,
    openaiModel: null,
    research: tech ? { ...DEFAULT_RESEARCH, extraInstructions: 'Prioritise the manufacturer product page and official documentation for specifications.' } : DEFAULT_RESEARCH,
    validation: { ...DEFAULT_VALIDATION, narrateSectionHeadings: false },
    archived: false,
    ...over
  }
}

function prompt(name: string, identity: string[]): string {
  return [
    `You write YouTube voiceover scripts for the channel ${name}.`,
    ...identity,
    'Preserve this channel\'s established format. Do not invent a fixed introduction, conclusion, call to action or section headings that are not stated below or shown by the approved reference scripts.'
  ].join('\n')
}

function format(
  name: string,
  contentType: string,
  status: TemplateApprovalStatus,
  o: { systemPrompt: string; confirmed: string[]; unverified: string[]; structure?: ScriptSection[]; notes?: string }
): SeedFormat {
  return {
    name,
    contentType,
    version: {
      systemPrompt: o.systemPrompt,
      structure: o.structure ?? [],
      exampleScript: null,
      notes: `${SEED_MARKER} ${o.notes ?? 'Created from the channel configuration document. Import approved reference scripts to verify the format.'}`,
      placeholder: status === 'not_configured',
      approvalStatus: status,
      fixedBlocks: [],
      findings: [],
      confirmedRules: o.confirmed.map((r) => `- ${r}`).join('\n'),
      unverified: o.unverified,
      headingsSpoken: false,
      referenceSetVersion: null
    }
  }
}

const NO_LINKS = ['No URLs or citations in the narration.']
const IMPORT_REQUIRED = (n: string): string[] => [
  `Exact narration template (opening, section order, closing) — import approved ${n} scripts.`,
  'Script length — measure from approved references.'
]

export const SEED_CHANNELS: SeedChannelV3[] = [
  // 01 — PlayTopia
  {
    channel: ch({
      name: 'PlayTopia',
      icon: '🎮',
      color: '#7C5CFF',
      category: 'gaming',
      description: 'Gaming reviews. Established channel with a strict approved format (max 4,700 characters). Template verification required.',
      targetDurationSec: 270,
      minChars: 3800,
      maxChars: 4700
    }),
    formats: [
      format('PlayTopia review', 'review', 'not_configured', {
        systemPrompt: prompt('PlayTopia', ['Category: gaming reviews. PlayTopia scripts must remain recognisable as PlayTopia scripts; never use the Game Vault, VoidPulse, Nexora or any other channel format.']),
        confirmed: ['English narration.', 'Maximum 4,700 characters.', 'Preserve the exact approved structure, introduction, conclusion and section order; only the game-specific information changes.', 'No URLs. No citations.', 'Clean narration suitable for ElevenLabs.'],
        unverified: [
          'Exact introduction wording — import from approved PlayTopia scripts.',
          'Exact section structure — import from approved PlayTopia scripts.',
          'Exact conclusion wording — import from approved PlayTopia scripts.',
          'Import at least three (preferably five) approved PlayTopia scripts before activation.'
        ],
        notes: 'TEMPLATE VERIFICATION REQUIRED. Generation stays blocked until approved references are imported and the extracted template is approved.'
      })
    ]
  },
  // 02 — Game Vault
  {
    channel: ch({
      name: 'Game Vault',
      icon: '🗝️',
      color: '#2DD4BF',
      category: 'gaming',
      description: 'Gaming reviews. Gameplay → Combat / Combat & Exploration → Pros → Cons → Conclusion. About 4–5 minutes.',
      targetDurationSec: 270,
      minChars: 3600,
      maxChars: 4700,
      validation: { ...DEFAULT_VALIDATION, narrateSectionHeadings: false, forbiddenPhrases: ['AAA'] }
    }),
    formats: [
      format('Game Vault review', 'review', 'provisional', {
        systemPrompt: prompt('Game Vault', [
          'Category: gaming reviews. Natural gaming review narration with clear explanations of gameplay, relevant combat or exploration details, meaningful positives, meaningful limitations and a balanced conclusion.',
          'Gameplay: explain the core gameplay loop — main objectives, player activities, progression, important mechanics, genre-specific systems. Only confirmed information.',
          'Combat (or Combat & Exploration): choose the variation that fits the game. Discuss combat interactions, exploration, enemy encounters, abilities, movement and environmental systems as relevant. Never invent combat for a game that has none.',
          'Pros: meaningful strengths supported by verified information or supplied notes. Cons: limitations supported by reliable evidence — never manufacture criticism to fill the section. Conclusion: a concise overall assessment.'
        ]),
        structure: [
          section('gameplay', 'Gameplay', 'Core loop, objectives, activities, progression, key mechanics.'),
          section('combat', 'Combat', 'Combat systems; use "Combat & Exploration" when exploration matters. No invented combat.', ['Combat & Exploration', 'Combat and Exploration']),
          section('pros', 'Pros', 'Meaningful, supported strengths.'),
          section('cons', 'Cons', 'Supported limitations; no manufactured criticism.'),
          section('conclusion', 'Conclusion', 'Concise, balanced overall assessment.')
        ],
        confirmed: [
          'Mandatory order: Gameplay; Combat OR Combat & Exploration; Pros; Cons; Conclusion. The order must not change and no extra major sections are added.',
          'Target approximately 4–5 minutes of narration.',
          'English, natural review narration, accurate information only.',
          'No URLs. No citations. Never use the term "AAA".'
        ],
        unverified: ['Exact fixed intro/outro wording — import from approved Game Vault scripts.'],
        notes: 'Provisional: the section structure is confirmed in writing; intro/outro wording still needs approved references. Usable in Review before voice until approved.'
      })
    ]
  },
  // 03 — VoidPulse
  {
    channel: ch({
      name: 'VoidPulse',
      icon: '🌀',
      color: '#F472B6',
      category: 'gaming',
      description:
        'Gaming content with its own writing identity (gameplay/discovery and review). Description/branding text only — never narrated unless an approved voiceover confirms it: "Every game has its own rhythm. This is where you experience it."'
    }),
    formats: [
      format('VoidPulse review', 'review', 'not_configured', {
        systemPrompt: prompt('VoidPulse', ['Category: gaming content, review mode. VoidPulse has a distinct identity and must never be treated as a duplicate of Game Vault or Nexora; never reuse another channel\'s introduction or conclusion.']),
        confirmed: ['English.', 'Distinctive writing style with a consistent structure within this mode.', 'No URLs in the narration.', 'Preserve the approved format.'],
        unverified: ['Exact review introduction, progression, paragraph style and conclusion — import the approved VoidPulse review script(s).', ...IMPORT_REQUIRED('VoidPulse review').slice(1)]
      }),
      format('VoidPulse gameplay / discovery', 'gameplay', 'not_configured', {
        systemPrompt: prompt('VoidPulse', ['Category: gaming content, gameplay / discovery mode (distraction-free gameplay and new-release discovery). Do not reuse the review-mode template.']),
        confirmed: ['English.', 'Distinctive writing style with a consistent structure within this mode.', 'No URLs in the narration.'],
        unverified: ['Approved gameplay-focused format — import approved VoidPulse gameplay scripts.', ...IMPORT_REQUIRED('VoidPulse gameplay').slice(1)]
      })
    ]
  },
  // 04 — Nexora
  {
    channel: ch({ name: 'Nexora', icon: '🔭', color: '#818CF8', category: 'gaming', description: 'Critical evaluation of new game releases, major and independent. Reference import required.' }),
    formats: [
      format('Nexora review', 'review', 'not_configured', {
        systemPrompt: prompt('Nexora', ['Category: gaming reviews. Known editorial identity (not a verified template): analytical, evaluation-focused, clear on strengths and weaknesses, more critical than promotional, focused on whether a game delivers on its design goals.']),
        confirmed: ['English.', ...NO_LINKS, PROVISIONAL_LENGTH],
        unverified: ['Exact opening, section order, review progression, tone, paragraph length, closing and character count — import approved Nexora scripts.']
      })
    ]
  },
  // 05 — RazorFrame
  {
    channel: ch({ name: 'RazorFrame', icon: '🗡️', color: '#F87171', category: 'gaming', description: 'Sharp, critical, analytical gaming reviews. Exact template not verified.' }),
    formats: [
      format('RazorFrame review', 'review', 'not_configured', {
        systemPrompt: prompt('RazorFrame', ['Category: gaming reviews. Known editorial identity: direct, precise, analytical, focused on gameplay quality, willing to identify meaningful weaknesses, no unnecessary promotional language. Keep it distinct from Nexora and Game Vault; no generic review introductions.']),
        confirmed: ['English.', ...NO_LINKS, PROVISIONAL_LENGTH],
        unverified: IMPORT_REQUIRED('RazorFrame')
      })
    ]
  },
  // 06 — Fluxor
  {
    channel: ch({
      name: 'Fluxor',
      icon: '⚡',
      color: '#FACC15',
      category: 'gaming',
      description: 'Concise, focused reviews of about 3–4 minutes. Proposed branding line (not a confirmed narration intro, never inserted automatically): "Three minutes. One game. One opinion."',
      targetDurationSec: 210,
      minChars: 2700,
      maxChars: 3600
    }),
    formats: [
      format('Fluxor review', 'review', 'not_configured', {
        systemPrompt: prompt('Fluxor', ['Category: gaming reviews. Editorial identity: compact, focused, distinctive, minimal filler, clear verdict. Do not copy other gaming channel formats.']),
        confirmed: ['English.', 'Approximately 3–4 minutes for the review format.', ...NO_LINKS],
        unverified: ['Exact narration template — import approved Fluxor scripts.', 'Whether any branding line belongs in the narration (not assumed).']
      })
    ]
  },
  // 07 — NexPlay Gaming
  {
    channel: ch({ name: 'NexPlay Gaming', icon: '🕹️', color: '#34D399', category: 'gaming', description: 'Short, focused reviews of new releases, about five minutes.', targetDurationSec: 300, minChars: 4000, maxChars: 4800 }),
    formats: [
      format('NexPlay review', 'review', 'not_configured', {
        systemPrompt: prompt('NexPlay Gaming', ['Category: gaming reviews. Content emphasis: gameplay, key mechanics, meaningful insights, important moments, overall evaluation. Focused and informative, no filler.']),
        confirmed: ['English.', 'Approximately five minutes.', ...NO_LINKS],
        unverified: ['Exact intro/outro and channel-specific structure — import approved NexPlay Gaming scripts.']
      })
    ]
  },
  // 08 — GameSense
  {
    channel: ch({ name: 'GameSense', icon: '🎯', color: '#60A5FA', category: 'gaming', description: 'Gaming coverage: gameplay, mechanics and first impressions. "Is It Worth Playing?" is a content concept, not an assumed opening line.' }),
    formats: [
      format('GameSense review', 'review', 'not_configured', {
        systemPrompt: prompt('GameSense', ['Category: gaming coverage and reviews. Editorial identity: informative, accessible, gameplay-focused, helps viewers understand what a game offers. The "Is It Worth Playing?" concept must not be used as a fixed opening line unless approved references show it.']),
        confirmed: ['English.', ...NO_LINKS, PROVISIONAL_LENGTH],
        unverified: IMPORT_REQUIRED('GameSense')
      })
    ]
  },
  // 09 — AperoX
  {
    channel: ch({ name: 'AperoX', icon: '🦅', color: '#FB923C', category: 'gaming', description: 'Gaming content. Format not recovered — import required.' }),
    formats: [
      format('AperoX format', 'review', 'not_configured', {
        systemPrompt: prompt('AperoX', ['Category: gaming content.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: ['Script structure, narration style, fixed introduction, conclusion and length — import approved AperoX scripts.']
      })
    ]
  },
  // 10 — Nyx Shadow
  {
    channel: ch({ name: 'Nyx Shadow', icon: '🌙', color: '#A78BFA', category: 'gaming', description: 'Gaming content. Exact script format not verified.' }),
    formats: [
      format('Nyx Shadow format', 'review', 'not_configured', {
        systemPrompt: prompt('Nyx Shadow', ['Category: gaming content. Do not infer a style from the channel name.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: IMPORT_REQUIRED('Nyx Shadow')
      })
    ]
  },
  // 11 — VELIX
  {
    channel: ch({ name: 'VELIX', icon: '💎', color: '#22D3EE', category: 'gaming', description: 'PC gaming reviews: gameplay, mechanics and what makes a game worth attention.' }),
    formats: [
      format('VELIX review', 'review', 'not_configured', {
        systemPrompt: prompt('VELIX', ['Category: PC gaming reviews. Known editorial focus: gameplay, core mechanics, important features, overall appeal. Maintain its own narration style; never copy Game Vault or NexPlay Gaming.']),
        confirmed: ['English.', ...NO_LINKS, PROVISIONAL_LENGTH],
        unverified: IMPORT_REQUIRED('VELIX')
      })
    ]
  },
  // 12 — GAMIX
  {
    channel: ch({ name: 'GAMIX', icon: '🧩', color: '#E879F9', category: 'gaming', description: 'Gaming content. Exact narration format not verified.' }),
    formats: [
      format('GAMIX format', 'review', 'not_configured', {
        systemPrompt: prompt('GAMIX', ['Category: gaming content.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: ['Introduction, conclusion and section order — import approved GAMIX scripts.', ...IMPORT_REQUIRED('GAMIX').slice(1)]
      })
    ]
  },
  // 13 — AxioS
  {
    channel: ch({ name: 'AxioS', icon: '🔷', color: '#38BDF8', category: 'gaming', description: 'Gaming content. Exact narration format not verified.' }),
    formats: [
      format('AxioS format', 'review', 'not_configured', {
        systemPrompt: prompt('AxioS', ['Category: gaming content. Do not create a style based on the channel name.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: IMPORT_REQUIRED('AxioS')
      })
    ]
  },
  // 14 — THE BLAZE
  {
    channel: ch({ name: 'THE BLAZE', icon: '🔥', color: '#F97316', category: 'gaming', description: 'Gaming content. Exact narration format not verified.' }),
    formats: [
      format('THE BLAZE format', 'review', 'not_configured', {
        systemPrompt: prompt('THE BLAZE', ['Category: gaming content. Do not use an exaggerated or aggressive tone because of the channel name.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: IMPORT_REQUIRED('THE BLAZE')
      })
    ]
  },
  // 15 — VIR3ON
  {
    channel: ch({ name: 'VIR3ON', icon: '🧬', color: '#4ADE80', category: 'gaming', description: 'Gaming content with a format deliberately distinct from the other channels. Not verified.' }),
    formats: [
      format('VIR3ON format', 'review', 'not_configured', {
        systemPrompt: prompt('VIR3ON', ['Category: gaming content.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: IMPORT_REQUIRED('VIR3ON')
      })
    ]
  },
  // RiftForge Tech
  (() => {
    const tech = [
      'English narration, natural spoken delivery.',
      'Accurate product specifications only; no fabricated benchmark results; no invented personal testing.',
      'No URLs in scripts.',
      'Use the established lowercase styling for abbreviations (usb-c, qmk, via, ghz).',
      'Keyboards: cover verified switch type, mounting structure, stabilizers, connectivity and sound characteristics; include a sound-test reference only when the approved format requires it and real sound-test material exists.',
      'Mini PCs: Cinebench, Geekbench, two or three games, performance, temperatures and noise — never invent scores, frame rates, temperatures or observations. Without real results, request them or present the script as a specifications-based overview.'
    ]
    const base = prompt('RiftForge Tech', ['Category: technology reviews and unboxings. Product-focused narration built on verified specifications; clearly distinguish specifications from actual testing.'])
    return {
      channel: ch({ name: 'RiftForge Tech', icon: '⚙️', color: '#F59E0B', category: 'tech', description: 'Technology reviews and unboxings: full reviews, unboxings and short reviews.', targetDurationSec: 300 }),
      formats: [
        format('RiftForge full review', 'full_review', 'provisional', { systemPrompt: `${base}\nFormat: full product review.`, confirmed: [...tech, PROVISIONAL_LENGTH], unverified: ['Exact approved RiftForge Tech review template — import approved scripts.'] }),
        format('RiftForge unboxing', 'unboxing', 'not_configured', { systemPrompt: `${base}\nFormat: unboxing.`, confirmed: tech, unverified: ['Exact unboxing template and length — import approved RiftForge unboxing scripts.'] }),
        format('RiftForge short review', 'short_review', 'not_configured', { systemPrompt: `${base}\nFormat: short review (shorter voiceover).`, confirmed: tech, unverified: ['Exact short-review template and length — import approved short scripts (the channel length limits apply to every format; adjust them for short batches).'] })
      ]
    }
  })(),
  // RENVO
  {
    channel: ch({
      name: 'RENVO',
      icon: '💠',
      color: '#0EA5E9',
      category: 'tech',
      description: 'Premium technology reviews (YouTube narration — separate from RENVO website articles).',
      targetDurationSec: 300
    }),
    formats: [
      format('RENVO YouTube review', 'youtube_review', 'provisional', {
        systemPrompt: prompt('RENVO', ['Category: premium technology reviews. Professional technology-review tone, accurate technical details, clear product evaluation. RENVO website article templates are a different content type and must not be used for voiceovers.']),
        structure: [
          section('introduction', 'Introduction', 'What the product is.'),
          section('unboxing', 'Unboxing', 'Only what was actually in the box per research or supplied notes.'),
          section('build', 'Build Quality & Design', 'Materials, finish, design — verified details only.'),
          section('features', 'Features', 'Key verified features and specifications.'),
          section('performance', 'Performance & Testing', 'Only supplied test results or clearly labelled manufacturer claims; no fabricated testing.'),
          section('proscons', 'Pros & Cons', 'Balanced strengths and weaknesses.'),
          section('verdict', 'Final Verdict', 'Clear evaluation.')
        ],
        confirmed: [
          'Review sequence: Introduction; Unboxing; Build Quality & Design; Features; Performance & Testing; Pros & Cons; Final Verdict (customisable).',
          'English, professional technology-review tone, accurate technical details.',
          'No fabricated hands-on testing. No URLs in voiceover scripts.',
          'Use the established lowercase styling for abbreviations (usb-c, qmk, via, ghz).',
          PROVISIONAL_LENGTH
        ],
        unverified: ['Exact narration template wording — import approved RENVO YouTube scripts.']
      }),
      format('RENVO product overview', 'product_overview', 'not_configured', {
        systemPrompt: prompt('RENVO', ['Category: premium technology, product overview format.']),
        confirmed: ['English, professional technology tone.', 'No fabricated hands-on testing.', 'No URLs.'],
        unverified: ['Product overview template and length — import approved RENVO overview scripts.']
      })
    ]
  },
  // PixelDrop (additional profile)
  {
    channel: ch({ name: 'PixelDrop', icon: '🟪', color: '#C084FC', category: 'gaming', description: 'Additional editable channel profile. Format not supplied yet.' }),
    formats: [
      format('PixelDrop format', 'review', 'not_configured', {
        systemPrompt: prompt('PixelDrop', ['Category: gaming content.']),
        confirmed: ['English.', ...NO_LINKS],
        unverified: IMPORT_REQUIRED('PixelDrop')
      })
    ]
  }
]
