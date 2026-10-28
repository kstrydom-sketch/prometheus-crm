/** Pure planning domain. No database, API calls, credentials, or live imports. */
export const CATEGORIES = [
  { id: 'textOffer', label: 'Text offer' },
  { id: 'refreshedStatic', label: 'Refreshed static' },
  { id: 'newStatic', label: 'New static' },
  { id: 'refreshedVideo', label: 'Refreshed video' },
  { id: 'motionGraphics', label: 'Motion graphics' },
] as const
export type Category = typeof CATEGORIES[number]['id']
export type Allocation = Record<Category, number>
export type Brand = {
  slug: string; name: string; cap: number; aliases: string[]
  contract: { kind: 'exact'; quantities: Allocation } | { kind: 'grouped'; static: number; motion: number } | { kind: 'flexible' }
}
export type StageOffer = { offer: string; startDate: string; endDate: string; sitewide: boolean; included: string; hasExclusions: boolean; exclusions: string }
export type CopyLine = { id: string; text: string; source: 'BF anterior' | 'Recente' | 'Nova' }
export type Draft = {
  schemaVersion: 1; brandSlug: string; revision: number; copyRevision: number; status: 'draft' | 'locked'
  offers: { pre: StageOffer; bf: StageOffer }; prePercent: number; allocation: Allocation; allocationLocks: Category[]
  copies: CopyLine[]; approvedCopiesRevision: number | null; motionIds: string[]; voiceover: boolean; sfx: boolean
  history: PlanVersion[]
}
export type PlanSnapshot = Omit<Draft, 'history'>
export type PlanVersion = { version: number; lockedAt: string; snapshot: PlanSnapshot }
export function suggestedAllocation(brand: Brand): Allocation {
  if (brand.contract.kind === 'exact') return { ...brand.contract.quantities }
  // Suggestions, NOT asserted contractual category quantities. Unknown contract values remain absent in contract.
  if (brand.contract.kind === 'grouped') return { textOffer: 0, refreshedStatic: 0, newStatic: brand.contract.static, refreshedVideo: 0, motionGraphics: brand.contract.motion }
  return { textOffer: 0, refreshedStatic: 0, newStatic: Math.round(brand.cap * .8), refreshedVideo: 0, motionGraphics: Math.round(brand.cap * .2) }
}
const blankOffer = (): StageOffer => ({ offer: '', startDate: '', endDate: '', sitewide: true, included: '', hasExclusions: false, exclusions: '' })
export function createDraft(brand: Brand, copies?: CopyLine[]): Draft {
  if (copies && (copies.length !== 30 || new Set(copies.map(c => c.id)).size !== 30)) throw new Error('Exactly 30 uniquely identified copy lines are required.')
  return { schemaVersion: 1, brandSlug: brand.slug, revision: 0, copyRevision: 0, status: 'draft', offers: { pre: blankOffer(), bf: blankOffer() }, prePercent: 30, allocation: suggestedAllocation(brand), allocationLocks: [], copies: copies ? structuredClone(copies) : Array.from({ length: 30 }, (_, i) => ({ id: `copy-${i + 1}`, text: '', source: 'Nova' as const })), approvedCopiesRevision: null, motionIds: [], voiceover: false, sfx: false, history: [] }
}
export function stageQuantities(total: number, prePercent: number) { const pre = Math.round(total * prePercent / 100); return { pre, bf: total - pre } }
export function validateAllocation(brand: Brand, allocation: Allocation): string[] {
  const errors: string[] = []
  if (CATEGORIES.some(c => !Number.isSafeInteger(allocation[c.id]) || allocation[c.id] < 0)) return ['Quantities must be non-negative whole numbers.']
  const total = CATEGORIES.reduce((n, c) => n + allocation[c.id], 0)
  if (total !== brand.cap) errors.push(`Allocate exactly ${brand.cap} creatives; currently ${total}.`)
  if (brand.contract.kind === 'exact') {
    const quantities = brand.contract.quantities
    if (CATEGORIES.some(c => allocation[c.id] > quantities[c.id])) errors.push('A category exceeds its contracted cap.')
  }
  if (brand.contract.kind === 'grouped') {
    if (allocation.textOffer + allocation.refreshedStatic + allocation.newStatic > brand.contract.static) errors.push('Static allocation exceeds its contracted cap.')
    if (allocation.refreshedVideo + allocation.motionGraphics > brand.contract.motion) errors.push('Motion allocation exceeds its contracted cap.')
  }
  return errors
}
function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value }
export function validateOffers(offers: Draft['offers']): string[] {
  return (['pre', 'bf'] as const).flatMap(stage => {
    const offer = offers[stage], label = stage === 'pre' ? 'Pre-BF' : 'Black Friday', errors: string[] = []
    if (!offer.offer.trim()) errors.push(`${label}: enter the current offer.`)
    if (!validDate(offer.startDate) || !validDate(offer.endDate)) errors.push(`${label}: enter valid start and end dates.`)
    else if (offer.endDate < offer.startDate) errors.push(`${label}: end date must follow start date.`)
    if (!offer.sitewide && !offer.included.trim()) errors.push(`${label}: enter included products or collections.`)
    if (offer.hasExclusions && !offer.exclusions.trim()) errors.push(`${label}: enter exclusions or turn exclusions off.`)
    return errors
  })
}
export function validateCopies(copies: CopyLine[]): string[] {
  return copies.length === 30 && new Set(copies.map(c => c.id)).size === 30 && copies.every(c => c.text.trim() && ['BF anterior', 'Recente', 'Nova'].includes(c.source)) ? [] : ['Complete all 30 copy lines before approving.']
}
export function validateDraft(brand: Brand, draft: Draft): string[] {
  return [...(draft.brandSlug !== brand.slug ? ['Brand mismatch.'] : []), ...validateOffers(draft.offers), ...validateAllocation(brand, draft.allocation), ...validateCopies(draft.copies), ...(!Number.isInteger(draft.prePercent) || draft.prePercent < 0 || draft.prePercent > 100 ? ['Stage allocation must be between 0 and 100%.'] : []), ...(draft.approvedCopiesRevision !== draft.copyRevision ? ['Explicitly approve the current 30 copy lines.'] : []), ...(draft.motionIds.length === 0 ? ['Select at least one motion reference.'] : [])]
}
export type DraftPatch = Partial<Pick<Draft, 'offers' | 'prePercent' | 'allocation' | 'allocationLocks' | 'copies' | 'motionIds' | 'voiceover' | 'sfx'>>
export function updateDraft(draft: Draft, patch: DraftPatch): Draft {
  if (draft.status === 'locked') throw new Error('Reopen this plan before editing.')
  if (patch.allocation && draft.allocationLocks.some(c => patch.allocation![c] !== draft.allocation[c])) throw new Error('Unlock the category before changing its quantity.')
  const invalidates = !!patch.copies || !!patch.offers
  return { ...draft, ...structuredClone(patch), revision: draft.revision + 1, copyRevision: draft.copyRevision + (invalidates ? 1 : 0), approvedCopiesRevision: invalidates ? null : draft.approvedCopiesRevision }
}
export function approveCopies(draft: Draft): Draft {
  if (draft.status === 'locked') throw new Error('Reopen this plan before editing.')
  const errors = validateCopies(draft.copies)
  if (errors.length) throw new Error(errors.join(' '))
  return { ...draft, revision: draft.revision + 1, approvedCopiesRevision: draft.copyRevision }
}
export function lockDraft(brand: Brand, draft: Draft, confirmed: boolean, now = new Date().toISOString()): Draft {
  if (!confirmed) throw new Error('Explicit confirmation is required.')
  if (draft.status === 'locked') throw new Error('This plan is already locked.')
  const errors = validateDraft(brand, draft)
  if (errors.length) throw new Error(errors.join(' '))
  const { history, ...snapshot } = structuredClone({ ...draft, revision: draft.revision + 1, status: 'locked' as const })
  return { ...snapshot, history: [...history, { version: history.length + 1, lockedAt: now, snapshot }] }
}
export function reopenDraft(draft: Draft, confirmed: boolean): Draft {
  if (!confirmed) throw new Error('Explicit reopen confirmation is required.')
  if (draft.status !== 'locked') throw new Error('Only locked plans can be reopened.')
  return { ...structuredClone(draft), status: 'draft', revision: draft.revision + 1, approvedCopiesRevision: null }
}
/** Reject corrupted/cross-brand local storage rather than trusting JSON casts. */
export function parseStoredDraft(raw: string, brandSlug: string): Draft | null {
  try {
    const draft: unknown = JSON.parse(raw)
    if (!isDraftShape(draft, brandSlug)) return null
    return draft
  } catch { return null }
}
function isDraftShape(value: unknown, brandSlug: string, historyAllowed = true): value is Draft {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  const isInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (d.schemaVersion !== 1 || d.brandSlug !== brandSlug || !['draft', 'locked'].includes(String(d.status)) || !isInt(d.revision) || !isInt(d.copyRevision)) return false
  if (typeof d.prePercent !== 'number' || !Number.isInteger(d.prePercent) || d.prePercent < 0 || d.prePercent > 100) return false
  if (d.approvedCopiesRevision !== null && (!isInt(d.approvedCopiesRevision) || d.approvedCopiesRevision !== d.copyRevision)) return false
  if (typeof d.voiceover !== 'boolean' || typeof d.sfx !== 'boolean') return false
  if (!d.offers || typeof d.offers !== 'object') return false
  for (const stage of ['pre', 'bf']) {
    const o = (d.offers as Record<string, unknown>)[stage]
    if (!o || typeof o !== 'object') return false
    const offer = o as Record<string, unknown>
    if (['offer', 'startDate', 'endDate', 'included', 'exclusions'].some(k => typeof offer[k] !== 'string') || typeof offer.sitewide !== 'boolean' || typeof offer.hasExclusions !== 'boolean') return false
  }
  if (!d.allocation || typeof d.allocation !== 'object' || CATEGORIES.some(c => !isInt((d.allocation as Record<string, unknown>)[c.id]))) return false
  if (!Array.isArray(d.allocationLocks) || d.allocationLocks.some(k => !CATEGORIES.some(c => c.id === k))) return false
  if (!Array.isArray(d.motionIds) || d.motionIds.some(id => typeof id !== 'string') || new Set(d.motionIds).size !== d.motionIds.length) return false
  if (!Array.isArray(d.copies) || d.copies.length !== 30 || d.copies.some(c => !c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.text !== 'string' || !['BF anterior', 'Recente', 'Nova'].includes(c.source))) return false
  if (new Set(d.copies.map(c => c.id)).size !== 30) return false
  if (historyAllowed) {
    if (!Array.isArray(d.history) || d.history.some((v, index) => !v || typeof v !== 'object' || v.version !== index + 1 || typeof v.lockedAt !== 'string' || !isDraftShape(v.snapshot, brandSlug, false))) return false
  } else if ('history' in d) return false
  return true
}
