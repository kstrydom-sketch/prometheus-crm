import { CATEGORIES, type Brand, type CopyLine } from './model'

export type MotionReference = { id: string; title: string; category: string; format: string; thumbnailUrl: string; videoUrl: string }
export type PlanConfig = {
  brand: Brand
  initialCopies: CopyLine[]
  motionReferences: MotionReference[]
  websiteFacts: { sources: { url: string; facts: string[] }[]; constraints: string[] }
  sourceNotice: string
}
/** Configuration is private database data, never compiled into the public repository. */
export function parsePlanConfig(value: unknown, slug: string): PlanConfig | null {
  if (!value || typeof value !== 'object') return null
  const config = value as PlanConfig
  const brand = config.brand
  if (!brand || brand.slug !== slug || typeof brand.name !== 'string' || !brand.name.trim() || !Number.isSafeInteger(brand.cap) || brand.cap < 1 || brand.cap > 100_000 || !Array.isArray(brand.aliases)) return null
  if (!brand.contract || !['exact', 'grouped', 'flexible'].includes(brand.contract.kind)) return null
  if (brand.contract.kind === 'exact' && (!brand.contract.quantities || Object.values(brand.contract.quantities).length !== 5 || CATEGORIES.some(c => !Number.isSafeInteger((brand.contract as { quantities: Record<string, number> }).quantities[c.id]) || (brand.contract as { quantities: Record<string, number> }).quantities[c.id] < 0))) return null
  if (brand.contract.kind === 'grouped' && (![brand.contract.static, brand.contract.motion].every(n => Number.isSafeInteger(n) && n >= 0))) return null
  if (!Array.isArray(config.initialCopies) || config.initialCopies.length !== 30 || config.initialCopies.some(c => !c || typeof c.id !== 'string' || typeof c.text !== 'string' || !['BF anterior', 'Recente', 'Nova'].includes(c.source)) || new Set(config.initialCopies.map(c => c.id)).size !== 30) return null
  const secureUrl = (url: unknown) => { try { return typeof url === 'string' && new URL(url).protocol === 'https:' } catch { return false } }
  if (!Array.isArray(config.motionReferences) || config.motionReferences.length !== 10 || new Set(config.motionReferences.map(r => r.id)).size !== 10 || config.motionReferences.some(r => !r || ['id','title','category','format'].some(k => typeof r[k as keyof MotionReference] !== 'string') || !secureUrl(r.thumbnailUrl) || !secureUrl(r.videoUrl))) return null
  if (typeof config.sourceNotice !== 'string' || !config.websiteFacts || !Array.isArray(config.websiteFacts.sources) || !Array.isArray(config.websiteFacts.constraints)) return null
  return config
}
