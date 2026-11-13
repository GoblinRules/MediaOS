import { z } from 'zod'
import { silentLog, type Log } from '../../log/Logger'

const version = z.string().regex(/^[0-9][A-Za-z0-9.+~-]{0,63}$/)
  .refine((value) => value === value.trim()).nullish().catch(undefined)
const time = z.iso.datetime({ offset: true })
const stateSchema = z.object({
  current: version, available: version, previous: version, skip: version,
  checkedAt: time.nullish().catch(undefined),
  lastRun: z.object({
    action: z.enum(['check', 'apply', 'auto', 'rollback']), ok: z.boolean(), at: time,
    error: z.string().nullish().catch(undefined),
  }).nullish().catch(undefined),
})
export type UpdateState = z.infer<typeof stateSchema>

export function parseUpdateState(text: string, logger: Log = silentLog): UpdateState {
  if (!text.trim()) return {}
  try { return stateSchema.parse(JSON.parse(text) as unknown) }
  catch { logger.warn('Update state could not be read'); return {} }
}

export function updateError(word: string | null | undefined, current: string): string {
  switch (word) {
    case 'not-set-up': return `Updates aren't set up on this box. It has MediaOS ${current}.`
    case 'offline': return "Can't reach the MediaOS update server. Check the box is online, then try again."
    case 'untrusted': return "The update couldn't be checked as genuine, so nothing was installed. Try again later."
    case 'server': return 'The update server had a problem. Try again in a few minutes.'
    case 'busy': return 'The box is busy installing something else. Try again in a few minutes.'
    case 'no-space': return "There isn't enough free space on the box for the update. It needs about 1 GB."
    case 'up-to-date': return 'MediaOS is already up to date.'
    case 'install-failed': return `The update couldn't be installed, so the box kept MediaOS ${current}. Try again later.`
    case 'no-previous': return "There's no earlier version on this box to go back to."
    case 'interrupted': return `The box was switched off part-way through, so it kept MediaOS ${current}. Try again.`
    default: return "The update didn't work. Try again later."
  }
}

/** Only the explicitly supported GitHub apt source can supply release notes. */
export function releaseRepository(sources: string): { owner: string; repo: string } | undefined {
  const uri = /^URIs:[ \t]*(.*)$/m.exec(sources)?.[1]?.trim()
  const match = uri?.match(
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/(?:latest\/download|download\/[^/\s]+)\/?$/,
  )
  return match ? { owner: match[1]!, repo: match[2]! } : undefined
}

const links = /!?\[([^[\]]*)\]\([^)]*\)/g
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

export function plainReleaseNotes(markdown: string): string {
  // Only the first 1,500 characters are shown, so tidy a bounded piece: the tag and link patterns slow down
  // quadratically on long runs of "<" or "[".
  const plain = markdown.slice(0, 6000)
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    // Twice, so a link around an image ("[![logo](a.png) Home](url)") loses both: the image first, then the link.
    .replace(links, '$1').replace(links, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
    .replace(/\*\*|__|`/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_all, name: string) => entities[name] ?? '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (plain.length <= 1500) return plain
  const prefix = plain.slice(0, 1500)
  const boundary = prefix.search(/\s+\S*$/)
  return `${prefix.slice(0, boundary > 0 ? boundary : 1499).trimEnd()}…`
}
