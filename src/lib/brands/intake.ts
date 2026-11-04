// Client intake: the one link a new client fills in so makers never start work
// without the logo, product images, fonts, colours, brand book, copy don'ts,
// the AI answer, the offer and who to talk to.
//
// Safe for server and browser. The answers live in brands.intake_form (JSON,
// so the form re-opens filled in) and are mirrored into the fields the rest of
// the app already reads: ai_sensitivity, preferred_channel, channel_details,
// intake_answers (readable text), brand_contacts and client_rules.

import { CHANNELS, type Channel } from './profile'

export interface IntakeContact {
  name: string
  role: string
  email: string
  phone: string
}

export interface IntakeForm {
  contacts: IntakeContact[]
  channel: Channel | ''
  channel_details: string
  /** 0-3, the same scale as brands.ai_sensitivity. null = not answered. */
  ai: number | null
  ai_note: string
  colours: string
  fonts: string
  voice: string
  copy_donts: string
  design_donts: string
  offer: string
  products: string
  asset_links: string
  anything_else: string
}

export const EMPTY_INTAKE: IntakeForm = {
  contacts: [{ name: '', role: '', email: '', phone: '' }],
  channel: '', channel_details: '',
  ai: null, ai_note: '',
  colours: '', fonts: '',
  voice: '', copy_donts: '', design_donts: '',
  offer: '', products: '',
  asset_links: '', anything_else: '',
}

// Client-facing wording for brands.ai_sensitivity. Same scale as BrandBrief.
export const AI_CHOICES = [
  { v: 0, label: 'Yes, AI is fine', hint: 'AI-generated images and copy are OK.' },
  { v: 1, label: 'Some AI is OK', hint: 'Fine within reason, as long as it looks real.' },
  { v: 2, label: 'Keep it minimal', hint: 'Prefer real photos of our products; AI only for small touches.' },
  { v: 3, label: 'No AI, please', hint: 'Only real photography and human-written copy.' },
] as const

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Whatever came back from the database or the browser, made into a form. */
export function normalizeIntake(raw: unknown): IntakeForm {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const contacts = Array.isArray(r.contacts)
    ? r.contacts.slice(0, 6).map(c => {
        const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
        return { name: str(o.name, 120), role: str(o.role, 120), email: str(o.email, 200), phone: str(o.phone, 60) }
      })
    : []
  const ai = typeof r.ai === 'number' && [0, 1, 2, 3].includes(r.ai) ? r.ai : null
  const channel = typeof r.channel === 'string' && r.channel in CHANNELS ? (r.channel as Channel) : ''
  return {
    contacts: contacts.length ? contacts : EMPTY_INTAKE.contacts,
    channel, channel_details: str(r.channel_details, 500),
    ai, ai_note: str(r.ai_note, 1000),
    colours: str(r.colours, 1000), fonts: str(r.fonts, 1000),
    voice: str(r.voice), copy_donts: str(r.copy_donts), design_donts: str(r.design_donts),
    offer: str(r.offer), products: str(r.products, 8000),
    asset_links: str(r.asset_links, 2000), anything_else: str(r.anything_else),
  }
}

export const filledContacts = (f: IntakeForm) => f.contacts.filter(c => c.name.trim())

/** One rule per line, bullets stripped. Feeds client_rules on submit. */
export function ruleLines(text: string): string[] {
  return text.split('\n').map(l => l.replace(/^\s*([-*•–]|\d+[.)])\s*/, '').trim()).filter(l => l.length > 1).slice(0, 30)
}

/** The readable version written to brands.intake_answers. */
export function intakeText(f: IntakeForm): string {
  const out: string[] = []
  const add = (q: string, a: string) => { if (a.trim()) out.push(`${q}\n${a.trim()}`) }
  const ai = AI_CHOICES.find(c => c.v === f.ai)
  add('Is AI-generated imagery or copy OK?', [ai?.label, f.ai_note].filter(Boolean).join(' — ') ?? '')
  add('Brand colours', f.colours)
  add('Fonts', f.fonts)
  add('How the brand sounds', f.voice)
  add("Words, claims or phrases to avoid", f.copy_donts)
  add("Visual don'ts", f.design_donts)
  add('Current offer basics', f.offer)
  add('Products', f.products)
  add('Asset links (Drive, Dropbox, …)', f.asset_links)
  add('Best way to reach us', [f.channel ? CHANNELS[f.channel] : '', f.channel_details].filter(Boolean).join(' — '))
  add('Points of contact', filledContacts(f).map(c => [c.name, c.role, c.email, c.phone].filter(Boolean).join(' · ')).join('\n'))
  add('Anything else', f.anything_else)
  return out.join('\n\n')
}

// ── Completeness ──────────────────────────────────────────────────────────

export type IntakeItemKey =
  | 'logo' | 'product_images' | 'fonts' | 'colours' | 'guidelines'
  | 'ai' | 'rules' | 'offer' | 'contact' | 'channel'

export interface IntakeItem {
  key: IntakeItemKey
  label: string
  done: boolean
  /** Why it counts as done, or what to do about it. */
  note?: string
}

export interface IntakeInputs {
  form: IntakeForm | null
  /** brand_documents.kind of every file on the brand. */
  docKinds: string[]
  hasGuidelineText: boolean
  aiSensitivity: number | null
  activeRuleCount: number
  contactCount: number
  preferredChannel: string | null
  dna?: { primary_font?: string | null; primary_color?: string | null } | null
}

/** What makers need before they start, and whether the brand has it. */
export function intakeCompleteness(i: IntakeInputs): IntakeItem[] {
  const f = i.form
  const count = (k: string) => i.docKinds.filter(d => d === k).length
  const linkNote = f?.asset_links.trim() ? 'Client shared a link instead; check it.' : undefined
  const files = (k: string, label: string): IntakeItem => {
    const n = count(k)
    return { key: k as IntakeItemKey, label, done: n > 0, note: n ? `${n} file${n === 1 ? '' : 's'}` : linkNote }
  }
  return [
    files('logo', 'Logo files'),
    files('product_images', 'Product images'),
    {
      key: 'fonts', label: 'Fonts',
      done: count('fonts') > 0 || !!f?.fonts.trim() || !!i.dna?.primary_font,
      note: count('fonts') ? `${count('fonts')} font file${count('fonts') === 1 ? '' : 's'}` : f?.fonts.trim() ? 'Named, no files' : i.dna?.primary_font ? 'From Brand DNA' : undefined,
    },
    { key: 'colours', label: 'Brand colours', done: !!f?.colours.trim() || !!i.dna?.primary_color, note: !f?.colours.trim() && i.dna?.primary_color ? 'From Brand DNA' : undefined },
    { key: 'guidelines', label: 'Brand guidelines', done: count('guidelines') > 0 || i.hasGuidelineText },
    { key: 'ai', label: 'OK to use AI?', done: i.aiSensitivity != null, note: i.aiSensitivity != null ? AI_CHOICES.find(c => c.v === i.aiSensitivity)?.label : undefined },
    { key: 'rules', label: "Copy & brand don'ts", done: i.activeRuleCount > 0 || !!f?.copy_donts.trim() || !!f?.design_donts.trim() },
    { key: 'offer', label: 'Offer & product list', done: !!f?.offer.trim() || !!f?.products.trim() },
    { key: 'contact', label: 'Point of contact', done: i.contactCount > 0 || (f ? filledContacts(f).length > 0 : false) },
    { key: 'channel', label: 'Preferred channel', done: !!i.preferredChannel },
  ]
}

export const missingItems = (items: IntakeItem[]) => items.filter(x => !x.done)

/** Everything a page needs to compute completeness, in one select each. */
export const INTAKE_BRAND_COLUMNS = 'id, name, intake_form, intake_submitted_at, intake_updated_at, ai_sensitivity, preferred_channel, brand_guidelines'

type Db = { from: (t: string) => any } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Completeness for one brand, for pages that do not already load its files,
 *  rules and contacts (job and project pages). Tolerant of missing tables. */
export async function loadIntakeStatus(supabase: Db, brandId: string) {
  const [{ data: brand }, { data: docs }, { data: rules }, { data: contacts }, { data: dna }] = await Promise.all([
    supabase.from('brands').select(INTAKE_BRAND_COLUMNS).eq('id', brandId).maybeSingle(),
    supabase.from('brand_documents').select('kind').eq('brand_id', brandId),
    supabase.from('client_rules').select('id').eq('brand_id', brandId).eq('status', 'active'),
    supabase.from('brand_contacts').select('id').eq('brand_id', brandId),
    supabase.from('brand_dna').select('primary_font, primary_color').eq('brand_id', brandId).eq('is_active', true).maybeSingle(),
  ])
  if (!brand) return null
  const b = brand as { name: string; intake_form: unknown; intake_submitted_at: string | null; ai_sensitivity: number | null; preferred_channel: string | null; brand_guidelines: string | null }
  const items = intakeCompleteness({
    form: b.intake_form ? normalizeIntake(b.intake_form) : null,
    docKinds: ((docs ?? []) as Array<{ kind: string | null }>).map(d => d.kind ?? 'other'),
    hasGuidelineText: !!b.brand_guidelines?.trim(),
    aiSensitivity: b.ai_sensitivity,
    activeRuleCount: (rules ?? []).length,
    contactCount: (contacts ?? []).length,
    preferredChannel: b.preferred_channel,
    dna: dna as IntakeInputs['dna'],
  })
  return { brandName: b.name, submittedAt: b.intake_submitted_at, items }
}

/** Token shape check before any query: 32 url-safe characters. */
export const isIntakeToken = (t: string) => /^[A-Za-z0-9_-]{32}$/.test(t)
