/**
 * Store links pasted as titles (1.6.1). A Steam store or community link identifies a game
 * exactly (its app id), so it is matched by id and researched with the link as a hint.
 * Shared by the main process (batch creation, Game Library) and the renderer (title preview).
 */

export interface StoreLink {
  store: 'steam'
  appId: string
  /** The link as pasted (trimmed). */
  url: string
  /** Canonical store URL for the app id. */
  canonicalUrl: string
  /** Display title derived from the URL slug ("" when the link has no slug). */
  slugTitle: string
}

const STEAM_PATTERNS: RegExp[] = [
  // store.steampowered.com/app/<id>/<slug>/  (also /agecheck/app/<id>/…, with or without scheme/www)
  /^(?:https?:\/\/)?(?:www\.)?store\.steampowered\.com\/(?:agecheck\/)?app\/(\d{1,10})(?:\/([^/?#\s]*))?/i,
  // steamcommunity.com/app/<id>[/…]
  /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/app\/(\d{1,10})(?:\/([^/?#\s]*))?/i,
  // s.team/a/<id>
  /^(?:https?:\/\/)?s\.team\/a\/(\d{1,10})()/i,
  // steam://store/<id>  steam://url/StoreAppPage/<id>
  /^steam:\/\/(?:store|url\/StoreAppPage)\/(\d{1,10})()/i
]

/** Words the community pages put where the store puts the slug. */
const COMMUNITY_SECTIONS = new Set(['discussions', 'guides', 'reviews', 'workshop', 'images', 'videos', 'screenshots', 'broadcasts', 'allnews', 'eventcomments', 'news'])

/** "Brick_by_Brick_Tidy_Up_the_Small_Town" → "Brick by Brick Tidy Up the Small Town"; "DisneyPixar_Toy_Story_3" → "Disney Pixar Toy Story 3". */
export function slugToTitle(slug: string): string {
  let s = slug
  try {
    s = decodeURIComponent(s)
  } catch {
    /* keep as typed */
  }
  return s
    .replace(/[_+]+/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll}{2,})/gu, '$1 $2')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseStoreLink(text: string): StoreLink | null {
  const url = text.trim().replace(/^<|>$/g, '')
  if (!url || /\s/.test(url)) return null
  for (const re of STEAM_PATTERNS) {
    const m = url.match(re)
    if (!m) continue
    const appId = String(Number(m[1]))
    if (!appId || appId === '0') return null
    const rawSlug = (m[2] ?? '').trim()
    const slug = rawSlug && !COMMUNITY_SECTIONS.has(rawSlug.toLowerCase()) && !/^\d+$/.test(rawSlug) ? rawSlug : ''
    return { store: 'steam', appId, url, canonicalUrl: `https://store.steampowered.com/app/${appId}/`, slugTitle: slug ? slugToTitle(slug) : '' }
  }
  return null
}

/** True for anything that looks like a link (store or not); such text never becomes a folder name as-is. */
export function looksLikeUrl(text: string): boolean {
  return /^(?:https?:\/\/|www\.|steam:\/\/)\S+$/i.test(text.trim())
}

/** Title used for a pasted link until research confirms the official one. */
export function storeLinkTitle(link: StoreLink): string {
  return link.slugTitle || `Steam app ${link.appId}`
}
