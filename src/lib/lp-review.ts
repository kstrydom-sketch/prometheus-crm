// The landing page's road from "built" to "in front of the client".
//
//   In Progress ──submit──▶ Internal Review ──▶ Internal Revisions ──▶ Discount Creation ──▶ Client Review
//        ▲  (checklist)           │  ▲ resubmit (checklist)  │
//        │                        └──┴──────────────────────┘
//
// Internal Revisions and Discount Creation are LP-only, so they are not Stage
// values: lp_stage stays 'internal_review' for the whole internal loop and
// projects.lp_internal_step says where in it the page is. See
// 20261013_add_lp_review_flow.sql for why.
//
// Shared by the browser (to show the gates) and by lp-review-actions.ts (to
// enforce them), so it must not import anything server-only.

import { normalizeStage, STAGE_LABELS, type Stage } from './types'
import { STAGE_COLORS } from './stageColors'
import { MB } from './brand-docs'

// Who reviews landing pages internally. Copy only — nothing is gated on it.
export const LP_INTERNAL_REVIEWER = 'Omkar'

export type LpInternalStep = 'review' | 'revisions' | 'discount'

type StageColor = { border: string; bg: string; text: string }

export const LP_STEP_META: Record<LpInternalStep, { label: string; colors: StageColor }> = {
  review:    { label: STAGE_LABELS.internal_review, colors: STAGE_COLORS.internal_review },
  revisions: { label: 'Internal Revisions', colors: { border: '#EC4899', bg: 'rgba(236,72,153,0.14)', text: '#EC4899' } },
  discount:  { label: 'Discount Creation',  colors: { border: '#A855F7', bg: 'rgba(168,85,247,0.14)', text: '#A855F7' } },
}

/** The sub-step, or null when the page is not in the internal loop at all. A
 *  NULL step inside internal_review is the first look: 'review'. */
export function lpStepOf(lpStage: string | null | undefined, step: string | null | undefined): LpInternalStep | null {
  if (normalizeStage(lpStage) !== 'internal_review') return null
  return step === 'revisions' || step === 'discount' ? step : 'review'
}

/** What to print for the LP track: the sub-step's name inside the internal
 *  loop, the stage's everywhere else. */
export function lpStageDisplay(lpStage: string | null | undefined, step: string | null | undefined): { label: string; colors: StageColor } {
  const s = lpStepOf(lpStage, step)
  if (s) return LP_STEP_META[s]
  const stage: Stage = normalizeStage(lpStage)
  return { label: STAGE_LABELS[stage], colors: STAGE_COLORS[stage] }
}

/** The page is being built or fixed — the checklist applies and the team owns it. */
export function lpIsBuilding(lpStage: string | null | undefined, step: string | null | undefined): boolean {
  const stage = normalizeStage(lpStage)
  return stage === 'brief' || stage === 'in_progress' || stage === 'revisions' || lpStepOf(stage, step) === 'revisions'
}

// ── JSONB shapes ────────────────────────────────────────────────────────────
// What we write. Reads go through the readers below, never a cast: the column
// holds whatever was put there, and NULL is the normal state.

export interface LpCheck { at: string; by: string }
export type LpChecklist = Record<string, LpCheck>

export type LpReviewEventKind = 'submitted' | 'changes_requested' | 'resubmitted' | 'approved'
export interface LpReviewEvent { kind: LpReviewEventKind; at: string; by: string }

export interface LpSubmission {
  at: string
  by: string
  by_id: string | null
  /** Manual checks confirmed at submission. */
  checks: string[]
  deliverable: 'url' | 'liquid'
  /** The page reached review without the checklist (stage rail, kanban drag,
   *  or before the flow existed). */
  bypassed?: boolean
  history: LpReviewEvent[]
}

export type LpDiscountMode = 'team' | 'client' | 'none'
export interface LpDiscount { mode: LpDiscountMode; at: string; by: string; note: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function readLpChecklist(raw: unknown): LpChecklist {
  if (!isObj(raw)) return {}
  const out: LpChecklist = {}
  for (const [k, v] of Object.entries(raw)) {
    if (isObj(v) && str(v.at)) out[k] = { at: v.at as string, by: str(v.by) ?? 'Someone' }
  }
  return out
}

const EVENT_KINDS: LpReviewEventKind[] = ['submitted', 'changes_requested', 'resubmitted', 'approved']

export function readLpSubmission(raw: unknown): LpSubmission | null {
  if (!isObj(raw) || !str(raw.at)) return null
  const history = Array.isArray(raw.history)
    ? raw.history.filter((e): e is LpReviewEvent =>
        isObj(e) && EVENT_KINDS.includes(e.kind as LpReviewEventKind) && !!str(e.at))
    : []
  return {
    at: raw.at as string,
    by: str(raw.by) ?? 'Someone',
    by_id: str(raw.by_id),
    checks: Array.isArray(raw.checks) ? raw.checks.filter((c): c is string => typeof c === 'string') : [],
    deliverable: raw.deliverable === 'liquid' ? 'liquid' : 'url',
    bypassed: raw.bypassed === true,
    history,
  }
}

const DISCOUNT_MODES: LpDiscountMode[] = ['team', 'client', 'none']

export function readLpDiscount(raw: unknown): LpDiscount | null {
  if (!isObj(raw) || !DISCOUNT_MODES.includes(raw.mode as LpDiscountMode) || !str(raw.at)) return null
  return { mode: raw.mode as LpDiscountMode, at: raw.at as string, by: str(raw.by) ?? 'Someone', note: str(raw.note) }
}

export const LP_DISCOUNT_LABELS: Record<LpDiscountMode, string> = {
  team: 'Created by us',
  client: 'Client creates it',
  none: 'No discount on this page',
}

// ── The pre-submission checklist ────────────────────────────────────────────
//
// Two kinds of item. AUTO items are read off the project — nobody can tick
// "discount guide written" while the box is empty. MANUAL items are a person
// saying they did it; they are emptied on every submission, so a page that
// came back with changes is re-tested before it goes in again.

export interface LpChecklistItem {
  key: string
  label: string
  help: string
  kind: 'auto' | 'manual'
  /** Only for pages handed in as a URL (a Liquid file has no public link). */
  urlOnly?: boolean
}

export const LP_CHECKLIST: LpChecklistItem[] = [
  { key: 'deliverable', kind: 'auto', label: 'Page handed in',
    help: 'The page URL in Final output — or, only if we have no store access, the Liquid files.' },
  { key: 'discount_guide', kind: 'auto', label: 'Discount setup guide written',
    help: 'How the discount should be set up in Shopify, in the Discount setup guide box above.' },
  { key: 'mobile', kind: 'manual', label: 'Tested on a real phone',
    help: 'On an actual phone, not a narrow browser window. Scroll the whole page: nothing cut off, overlapping or scrolling sideways; sticky bars and menus work.' },
  { key: 'desktop', kind: 'manual', label: 'Tested on desktop',
    help: 'On a laptop and a wide screen. The layout holds, images are sharp, hover states work.' },
  { key: 'links', kind: 'manual', label: 'Every button and link works',
    help: 'Each CTA goes to the right product, variant or collection. No dead links, none pointing back at a template page.' },
  { key: 'checkout', kind: 'manual', label: 'Add to cart and checkout work',
    help: 'Add the offer product and get to checkout: right product, variant and quantity in the cart.' },
  { key: 'copy', kind: 'manual', label: 'Copy and offer match the brief',
    help: 'Headline, prices, offer terms and dates match the approved offer. Proofread — no typos, no placeholder or lorem ipsum text.' },
  { key: 'media', kind: 'manual', label: 'Images and video load properly',
    help: 'Nothing broken or blurry, files compressed, and the page loads quickly on mobile data.' },
  { key: 'brand', kind: 'manual', label: 'On brand',
    help: 'Fonts, colours, logo and tone follow the brand guidelines.' },
  { key: 'private_window', kind: 'manual', label: 'Opens in a private window', urlOnly: true,
    help: 'Open the URL logged out (incognito), not only while signed in to Shopify. No password page, no expiring theme preview link.' },
]

/** Ticked instead of writing a guide, for a page that has no discount. */
export const NO_DISCOUNT_KEY = 'no_discount'

export const MANUAL_CHECK_KEYS = new Set([
  ...LP_CHECKLIST.filter(i => i.kind === 'manual').map(i => i.key),
  NO_DISCOUNT_KEY,
])

export interface LpChecklistProject {
  lp_url: string | null
  shopify_coupon_code: string | null
  lp_liquid_reason?: string | null
  lp_checklist?: unknown
}

export interface LpChecklistRow extends LpChecklistItem {
  done: boolean
  /** Who ticked it — manual items only. */
  check: LpCheck | null
}

export interface LpChecklistResult {
  rows: LpChecklistRow[]
  done: number
  total: number
  complete: boolean
  /** How the page is being handed in; null until it is. */
  deliverable: 'url' | 'liquid' | null
}

export function evaluateLpChecklist(p: LpChecklistProject, liquidFileCount: number): LpChecklistResult {
  const ticks = readLpChecklist(p.lp_checklist)
  const deliverable: 'url' | 'liquid' | null = p.lp_url?.trim()
    ? 'url'
    : liquidFileCount > 0 && !!p.lp_liquid_reason?.trim() ? 'liquid' : null

  const rows: LpChecklistRow[] = LP_CHECKLIST
    // A URL-only check means nothing for a Liquid hand-in. Until the page is
    // handed in either way, it stays on the list.
    .filter(item => !(item.urlOnly && deliverable === 'liquid'))
    .map(item => {
      if (item.key === 'deliverable') return { ...item, done: deliverable !== null, check: null }
      if (item.key === 'discount_guide') {
        const noDiscount = ticks[NO_DISCOUNT_KEY] ?? null
        return { ...item, done: !!p.shopify_coupon_code?.trim() || !!noDiscount, check: noDiscount }
      }
      const check = ticks[item.key] ?? null
      return { ...item, done: !!check, check }
    })

  const done = rows.filter(r => r.done).length
  return { rows, done, total: rows.length, complete: done === rows.length, deliverable }
}

// ── Liquid files ────────────────────────────────────────────────────────────
//
// Stored in the private brand-docs bucket, which already allows text/plain —
// every theme file is text, so every one is uploaded as text/plain and the
// bucket needs no change. The extension in the PATH comes from this allowlist,
// never from the file name.

export const LIQUID_EXTS = ['liquid', 'json', 'css', 'js'] as const
export const LIQUID_ACCEPT = LIQUID_EXTS.map(e => `.${e}`).join(',')
export const LIQUID_CONTENT_TYPE = 'text/plain'
// Theme files are kilobytes. 5MB is generous and still nowhere near the
// bucket's own 50MB ceiling.
export const MAX_LIQUID_BYTES = 5 * MB

export function liquidExt(fileName: string): (typeof LIQUID_EXTS)[number] | null {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  return (LIQUID_EXTS as readonly string[]).includes(ext) ? (ext as (typeof LIQUID_EXTS)[number]) : null
}

export function liquidPath(projectId: string, ext: string): string {
  return `lp-liquid/${projectId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
}

export function safeLiquidName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  return cleaned || 'page.liquid'
}

export interface LpLiquidFile {
  id: string
  project_id: string
  storage_path: string
  file_name: string
  byte_size: number
  uploaded_by: string | null
  uploaded_by_name: string | null
  created_at: string
}
