'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { canEdit } from '@/lib/permissions'
import { LP_SECTIONS, normalizeStage } from '@/lib/types'
import { actorFromUser, eventsEnabled, logEvents } from '@/lib/events'
import { createNotifications } from '@/lib/notifications'
import { BRAND_DOC_BUCKET, asciiDocName, isUuid } from '@/lib/brand-docs'
import {
  MANUAL_CHECK_KEYS, MAX_LIQUID_BYTES,
  evaluateLpChecklist, liquidExt, liquidPath, lpIsBuilding, lpStepOf,
  effectiveLpTicks, readLpDiscount, readLpSubmission, safeLiquidName,
  type LpDiscountMode, type LpReviewEvent, type LpSubmission,
} from '@/lib/lp-review'

// Server side of the LP review flow — see lib/lp-review.ts for the shape of it.
//
// Every gate the UI shows is enforced again here, because the UI is only the
// first of several ways to call these. Failures are RETURNED, not thrown: Next
// strips a thrown Server Action's message in production, and "Finish the
// checklist first — 6 of 9 done" is the whole point of the gate.

type Result = { ok: true } | { ok: false; error: string }

const MIGRATION_MSG = 'The LP review flow needs its database update first — run 20261013_add_lp_review_flow.sql.'

const LP_COLS =
  'id, brand_id, name, lp_editor_id, created_by, is_complete, lp_stage, lp_url, shopify_coupon_code, marketing_moment, ' +
  'lp_internal_step, lp_checklist, lp_submission, lp_discount, lp_liquid_reason'

type LpRow = {
  id: string
  brand_id: string
  name: string
  lp_editor_id: string | null
  created_by: string | null
  is_complete: boolean
  lp_stage: string
  lp_url: string | null
  shopify_coupon_code: string | null
  marketing_moment: number | null
  lp_internal_step: string | null
  lp_checklist: unknown
  lp_submission: unknown
  lp_discount: unknown
  lp_liquid_reason: string | null
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function staff() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!(await canEdit(user.email))) throw new Error('Not authorized.')

  // By email, not id — profiles.id is not reliably the auth uid (see
  // attachBrandDocument).
  const { data: prof } = await supabase
    .from('profiles').select('full_name').ilike('email', user.email ?? '').maybeSingle()
  const name = (prof as { full_name: string | null } | null)?.full_name?.trim()
    || user.email?.split('@')[0] || 'Team'
  return { supabase, user, name }
}

async function readLp(supabase: Supabase, projectId: string, brandId: string): Promise<LpRow | string> {
  if (!isUuid(projectId)) return 'Unknown project.'
  const { data, error } = await supabase.from('projects').select(LP_COLS).eq('id', projectId).maybeSingle()
  if (error?.code === '42703') return MIGRATION_MSG
  if (error) return error.message
  const row = data as unknown as LpRow | null
  if (!row || row.brand_id !== brandId) return 'That project no longer exists.'
  if (row.is_complete) return 'This project is complete. Reopen it first.'
  return row
}

async function liquidCount(supabase: Supabase, projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from('lp_liquid_files')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
  return error ? 0 : count ?? 0
}

/** Internal LP notes nobody has ticked off yet. */
async function openInternalCount(supabase: Supabase, projectId: string): Promise<number> {
  const { count } = await supabase
    .from('project_comments')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('track', 'lp')
    .eq('audience', 'internal')
    .is('resolved_at', null)
  return count ?? 0
}

function revalidateProject(brandId: string, projectId: string, boards = false) {
  revalidatePath(`/brands/${brandId}/projects/${projectId}`)
  revalidatePath(`/preview/project/${projectId}`)
  if (boards) {
    revalidatePath('/')
    revalidatePath('/pipeline')
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// ── Checklist ───────────────────────────────────────────────────────────────

export async function toggleLpChecklistItem(
  projectId: string,
  brandId: string,
  key: string,
  done: boolean,
): Promise<Result> {
  const { supabase, name } = await staff()
  if (!MANUAL_CHECK_KEYS.has(key)) return { ok: false, error: 'Unknown checklist item.' }

  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }
  if (!lpIsBuilding(p.lp_stage, p.lp_internal_step)) {
    return { ok: false, error: 'The checklist is for while the page is being built or fixed.' }
  }

  // Read-modify-write on one small object. Two people ticking different items
  // in the same second could lose one tick; the page refreshes after every
  // tick, so a lost one is visible and costs a click.
  const ticks = effectiveLpTicks(p)
  if (done) ticks[key] = { at: new Date().toISOString(), by: name }
  else delete ticks[key]

  const { error } = await supabase
    .from('projects')
    .update({ lp_checklist: Object.keys(ticks).length ? ticks : null })
    .eq('id', projectId)
  if (error) return { ok: false, error: error.message }

  revalidateProject(brandId, projectId)
  return { ok: true }
}

// ── Submit (and resubmit) for internal review ───────────────────────────────

export async function submitLpForInternalReview(projectId: string, brandId: string): Promise<Result> {
  const { supabase, user, name } = await staff()
  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }

  const stage = normalizeStage(p.lp_stage)
  const step = lpStepOf(p.lp_stage, p.lp_internal_step)
  if (!lpIsBuilding(p.lp_stage, p.lp_internal_step)) {
    return { ok: false, error: 'This page is not being built or fixed right now, so there is nothing to submit.' }
  }

  const checklist = evaluateLpChecklist(p, await liquidCount(supabase, projectId))
  if (!checklist.complete) {
    return { ok: false, error: `Finish the checklist first — ${checklist.done} of ${checklist.total} done.` }
  }

  const resubmit = step === 'revisions'
  if (resubmit) {
    const open = await openInternalCount(supabase, projectId)
    if (open > 0) {
      return { ok: false, error: `${plural(open, 'internal note')} still open. Tick each one off once it is fixed.` }
    }
  }

  const now = new Date().toISOString()
  const prev = readLpSubmission(p.lp_submission)
  const event: LpReviewEvent = { kind: resubmit ? 'resubmitted' : 'submitted', at: now, by: name }
  const ticks = effectiveLpTicks(p)
  const submission: LpSubmission = {
    at: now,
    by: name,
    by_id: user.id,
    checks: Object.keys(ticks).filter(k => MANUAL_CHECK_KEYS.has(k)),
    deliverable: checklist.deliverable ?? 'url',
    // A resubmission continues this stay's history; a fresh submission (from
    // In Progress or client Revisions) starts a new one.
    history: [...(resubmit && prev ? prev.history : []), event],
  }

  // Guarded on the stage we read, so a move made by someone else in between
  // is not silently overwritten. The ticks are written back, not cleared:
  // they carry into the next round (see lib/lp-review.ts).
  const { data: moved, error } = await supabase
    .from('projects')
    .update({ lp_stage: 'internal_review', lp_internal_step: 'review', lp_submission: submission, lp_checklist: Object.keys(ticks).length ? ticks : null })
    .eq('id', projectId)
    .eq('lp_stage', p.lp_stage)
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!moved?.length) return { ok: false, error: 'Someone moved this page in the meantime. Refresh and try again.' }

  if (stage !== 'internal_review' && eventsEnabled()) {
    await logEvents([{
      event_type: 'stage_changed',
      card_id: projectId,
      brand_id: brandId,
      track: 'lp',
      from_stage: p.lp_stage,
      to_stage: 'internal_review',
      ...actorFromUser(user),
      payload: { marketing_moment: p.marketing_moment, via: 'lp_checklist' },
    }])
  }

  // Boards too, even on a resubmit: the LP badge goes from Internal Revisions
  // back to Internal Review.
  revalidateProject(brandId, projectId, true)
  return { ok: true }
}

// ── Internal feedback ───────────────────────────────────────────────────────

export async function addLpInternalFeedback(
  projectId: string,
  brandId: string,
  input: { content: string; sectionTag: string | null; attachmentUrls: string[] },
): Promise<Result> {
  const { supabase, user, name } = await staff()

  const content = input.content.trim()
  const attachments = input.attachmentUrls.filter(u => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 10)
  if (!content && attachments.length === 0) return { ok: false, error: 'Write the note, or attach a screenshot.' }
  const section = input.sectionTag && (LP_SECTIONS as readonly string[]).includes(input.sectionTag) ? input.sectionTag : null

  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }

  // audience 'internal' + author_id set: the client review link filters out
  // both, so this can never reach the client.
  const { error } = await supabase.from('project_comments').insert({
    project_id: projectId,
    author_name: name,
    author_id: user.id,
    content,
    track: 'lp',
    asset_id: null,
    pin_x: null,
    pin_y: null,
    section_tag: section,
    attachment_urls: attachments.length ? attachments : null,
    audience: 'internal',
  })
  if (error) return { ok: false, error: `Could not save the note: ${error.message}` }

  revalidateProject(brandId, projectId)
  return { ok: true }
}

// ── Reviewer decisions ──────────────────────────────────────────────────────

/** This stay's submission with one more event on it. A page moved into review
 *  on the stage rail has none, so one is started and marked as bypassed. */
function withEvent(p: LpRow, event: LpReviewEvent): LpSubmission {
  const prev = readLpSubmission(p.lp_submission)
  if (prev) return { ...prev, history: [...prev.history, event] }
  return {
    at: event.at, by: event.by, by_id: null, checks: [],
    deliverable: p.lp_url?.trim() ? 'url' : 'liquid',
    bypassed: true,
    history: [event],
  }
}

export async function requestLpChanges(projectId: string, brandId: string): Promise<Result> {
  const { supabase, user, name } = await staff()
  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }
  if (lpStepOf(p.lp_stage, p.lp_internal_step) !== 'review') {
    return { ok: false, error: 'This page is not waiting on internal review.' }
  }
  const open = await openInternalCount(supabase, projectId)
  if (open === 0) {
    return { ok: false, error: 'Add at least one note saying what to change first.' }
  }

  const submission = withEvent(p, { kind: 'changes_requested', at: new Date().toISOString(), by: name })
  const { data: moved, error } = await supabase
    .from('projects')
    .update({ lp_internal_step: 'revisions', lp_submission: submission })
    .eq('id', projectId)
    .eq('lp_stage', 'internal_review')
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!moved?.length) return { ok: false, error: 'Someone moved this page in the meantime. Refresh and try again.' }

  // Tell whoever builds the page that it came back. The assigned LP editor,
  // plus whoever submitted it if that was someone else; the project's creator
  // when neither is known (same fallback as client feedback). Never the
  // reviewer themselves.
  //
  // Type 'mentioned', not a new type: notifications.type has a CHECK of three
  // values, widening it means replacing the constraint, and the bell renders
  // only title/body/link — the type is never shown.
  const builders = [p.lp_editor_id, readLpSubmission(p.lp_submission)?.by_id ?? null].filter((id): id is string => !!id)
  const recipients = (builders.length ? builders : [p.created_by]).filter((id): id is string => !!id && id !== user.id)
  await createNotifications(recipients.map(recipient_id => ({
    recipient_id,
    actor_id: user.id,
    actor_label: name,
    type: 'mentioned' as const,
    project_id: projectId,
    brand_id: brandId,
    title: `${name} sent the landing page back with ${plural(open, 'note')}`,
    body: `${p.name} — fix each note, tick it off, then resubmit.`,
    link: `/brands/${brandId}/projects/${projectId}#internal-review`,
  })))

  revalidateProject(brandId, projectId, true)
  return { ok: true }
}

export async function approveLpInternalReview(projectId: string, brandId: string): Promise<Result> {
  const { supabase, name } = await staff()
  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }
  // From Internal Revisions too: once every note is ticked off the reviewer
  // can approve on the spot, instead of waiting for a formal resubmit only to
  // look at the same fixes again.
  const step = lpStepOf(p.lp_stage, p.lp_internal_step)
  if (step !== 'review' && step !== 'revisions') {
    return { ok: false, error: 'This page is not in internal review.' }
  }
  const open = await openInternalCount(supabase, projectId)
  if (open > 0) {
    return { ok: false, error: `${plural(open, 'internal note')} still open. Tick them off once fixed${step === 'review' ? ', or send them back as changes' : ''}.` }
  }

  const submission = withEvent(p, { kind: 'approved', at: new Date().toISOString(), by: name })
  const { data: moved, error } = await supabase
    .from('projects')
    .update({ lp_internal_step: 'discount', lp_submission: submission })
    .eq('id', projectId)
    .eq('lp_stage', 'internal_review')
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!moved?.length) return { ok: false, error: 'Someone moved this page in the meantime. Refresh and try again.' }

  revalidateProject(brandId, projectId, true)
  return { ok: true }
}

// ── Discount creation ───────────────────────────────────────────────────────

const DISCOUNT_MODES: LpDiscountMode[] = ['team', 'client', 'none']

/** Record how the page's discount was set up, or clear it (mode null). */
export async function recordLpDiscount(
  projectId: string,
  brandId: string,
  mode: LpDiscountMode | null,
  note: string,
): Promise<Result> {
  const { supabase, name } = await staff()
  if (mode !== null && !DISCOUNT_MODES.includes(mode)) return { ok: false, error: 'Unknown discount option.' }

  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }

  const cleanNote = note.trim().slice(0, 2000) || null
  const { error } = await supabase
    .from('projects')
    .update({ lp_discount: mode ? { mode, at: new Date().toISOString(), by: name, note: cleanNote } : null })
    .eq('id', projectId)
  if (error) return { ok: false, error: error.message }

  revalidateProject(brandId, projectId)
  return { ok: true }
}

export async function sendLpToClientReview(projectId: string, brandId: string): Promise<Result> {
  const { supabase, user } = await staff()
  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }
  if (lpStepOf(p.lp_stage, p.lp_internal_step) !== 'discount') {
    return { ok: false, error: 'The page has to pass internal review before it goes to the client.' }
  }
  const discount = readLpDiscount(p.lp_discount)
  if (!discount) return { ok: false, error: 'Record how the discount was set up first.' }

  // The sub-step and submission only describe the internal loop, which this
  // ends. Their story survives in the event payload below.
  const { data: moved, error } = await supabase
    .from('projects')
    .update({ lp_stage: 'client_review', lp_internal_step: null, lp_submission: null })
    .eq('id', projectId)
    .eq('lp_stage', 'internal_review')
    .eq('lp_internal_step', 'discount')
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!moved?.length) return { ok: false, error: 'Someone moved this page in the meantime. Refresh and try again.' }

  if (eventsEnabled()) {
    const sub = readLpSubmission(p.lp_submission)
    const actor = actorFromUser(user)
    await logEvents([
      {
        event_type: 'stage_changed',
        card_id: projectId,
        brand_id: brandId,
        track: 'lp',
        from_stage: 'internal_review',
        to_stage: 'client_review',
        ...actor,
        payload: { marketing_moment: p.marketing_moment, via: 'lp_review_flow' },
      },
      {
        event_type: 'sent_to_client',
        card_id: projectId,
        brand_id: brandId,
        track: 'lp',
        ...actor,
        payload: {
          via: 'lp_review_flow',
          deliverable: sub?.deliverable ?? (p.lp_url ? 'url' : 'liquid'),
          discount: discount.mode,
          review_history: sub?.history ?? [],
        },
      },
    ])
  }

  revalidateProject(brandId, projectId, true)
  return { ok: true }
}

// ── Liquid files (last resort, no store access) ─────────────────────────────

const LIQUID_REFUSED_URL = 'This page has a URL. Liquid files are only for when we have no access to the client’s store.'

export async function setLpLiquidReason(projectId: string, brandId: string, reason: string): Promise<Result> {
  const { supabase } = await staff()
  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }

  const clean = reason.trim().slice(0, 1000)
  if (clean && p.lp_url?.trim()) return { ok: false, error: LIQUID_REFUSED_URL }

  const { error } = await supabase.from('projects').update({ lp_liquid_reason: clean || null }).eq('id', projectId)
  if (error) return { ok: false, error: error.message }

  revalidateProject(brandId, projectId)
  return { ok: true }
}

// Two-step upload, like brand documents: the browser sends the bytes straight
// to a signed URL (a Server Action body is capped at 1MB), and attach only
// records the row.
export async function createLpLiquidUploadUrl(
  projectId: string,
  brandId: string,
  fileName: string,
  byteSize: number,
): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  const { supabase } = await staff()

  const ext = liquidExt(fileName)
  if (!ext) return { ok: false, error: 'Only .liquid, .json, .css and .js theme files can be handed in.' }
  if (!Number.isFinite(byteSize) || byteSize <= 0) return { ok: false, error: 'That file is empty.' }
  if (byteSize > MAX_LIQUID_BYTES) return { ok: false, error: `That file is over the ${MAX_LIQUID_BYTES / 1048576}MB limit.` }

  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }
  if (p.lp_url?.trim()) return { ok: false, error: LIQUID_REFUSED_URL }
  if (!p.lp_liquid_reason?.trim()) return { ok: false, error: 'Say why we have no store access before uploading.' }

  const { data, error } = await supabase.storage
    .from(BRAND_DOC_BUCKET)
    .createSignedUploadUrl(liquidPath(projectId, ext))
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not start the upload.' }
  return { ok: true, path: data.path, token: data.token }
}

export async function attachLpLiquidFile(
  projectId: string,
  brandId: string,
  input: { path: string; fileName: string; byteSize: number },
): Promise<Result> {
  const { supabase, user, name } = await staff()
  if (!isUuid(projectId)) return { ok: false, error: 'Unknown project.' }

  // Minted by createLpLiquidUploadUrl; checked anyway, it comes from the browser.
  const ext = liquidExt(input.path)
  if (!input.path.startsWith(`lp-liquid/${projectId}/`) || input.path.includes('..') || !ext) {
    return { ok: false, error: 'That upload does not belong to this project.' }
  }
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0 || input.byteSize > MAX_LIQUID_BYTES) {
    return { ok: false, error: 'That file is outside the size limit.' }
  }

  const p = await readLp(supabase, projectId, brandId)
  if (typeof p === 'string') return { ok: false, error: p }

  const { error } = await supabase.from('lp_liquid_files').insert({
    project_id: projectId,
    storage_path: input.path,
    file_name: safeLiquidName(input.fileName),
    byte_size: Math.round(input.byteSize),
    uploaded_by: user.id,
    uploaded_by_name: name,
  })
  if (error) {
    if (error.code === '42P01') return { ok: false, error: MIGRATION_MSG }
    return { ok: false, error: `Could not save that file: ${error.message}` }
  }

  revalidateProject(brandId, projectId)
  return { ok: true }
}

// Signed on click, never embedded in the page — same reasoning as
// getBrandDocumentUrl. 'view' opens the raw text in a tab for review.
export async function getLpLiquidFileUrl(
  fileId: string,
  mode: 'view' | 'download',
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { supabase } = await staff()
  if (!isUuid(fileId)) return { ok: false, error: 'Unknown file.' }

  const { data: row } = await supabase
    .from('lp_liquid_files').select('storage_path, file_name').eq('id', fileId).maybeSingle()
  if (!row) return { ok: false, error: 'That file is no longer here.' }
  const file = row as { storage_path: string; file_name: string }

  const { data, error } = await supabase.storage
    .from(BRAND_DOC_BUCKET)
    .createSignedUrl(file.storage_path, 300, mode === 'download' ? { download: asciiDocName(file.file_name) } : undefined)
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not open that file.' }
  return { ok: true, url: data.signedUrl }
}

// Row first, then the object — see removeBrandDocument for why that order.
export async function removeLpLiquidFile(fileId: string, projectId: string, brandId: string): Promise<Result> {
  const { supabase } = await staff()
  if (!isUuid(fileId)) return { ok: false, error: 'Unknown file.' }

  const { data: row } = await supabase
    .from('lp_liquid_files').select('storage_path').eq('id', fileId).eq('project_id', projectId).maybeSingle()
  if (!row) return { ok: false, error: 'That file is already gone.' }

  const { error } = await supabase.from('lp_liquid_files').delete().eq('id', fileId).eq('project_id', projectId)
  if (error) return { ok: false, error: `Could not remove it: ${error.message}` }

  const path = (row as { storage_path: string }).storage_path
  const { error: rmErr } = await supabase.storage.from(BRAND_DOC_BUCKET).remove([path])
  if (rmErr) console.error('[removeLpLiquidFile] orphaned object', path, rmErr.message)

  revalidateProject(brandId, projectId)
  return { ok: true }
}
