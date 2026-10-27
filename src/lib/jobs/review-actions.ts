'use server'

// Review buttons on the job page. Each one moves the CARD (offer or production)
// through the same actions and gates the card's own page uses; the database
// trigger then records the round and updates the steps. Nothing here writes a
// step status or a round outcome directly.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { canEdit } from '@/lib/permissions'
import { updateProjectStage } from '@/lib/actions'
import {
  addLpInternalFeedback, approveLpInternalReview, requestLpChanges, sendLpToClientReview, submitLpForInternalReview,
} from '@/lib/lp-review-actions'
import { autoCreateEnabled, createProductionCardFromOffer } from '@/lib/offer-to-production'
import { creativeState, nextActions, offerState, trackState, type Deliverable, type ReviewAction, type ReviewRound } from './review'

type Result = { ok: true } | { ok: false; error: string }

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function runReviewAction(jobId: string, deliverable: Deliverable, action: ReviewAction, note = ''): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!(await canEdit(user.email))) return { ok: false, error: 'Not authorized.' }
  const { data: me } = await supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle()
  const name = me?.full_name?.trim() || user.email?.split('@')[0] || 'Someone'
  const cleanNote = note.trim().slice(0, 4000)

  const { data: job } = await supabase.from('jobs').select('id, brand_id, offer_card_id, project_id').eq('id', jobId).single()
  if (!job) return { ok: false, error: 'Job not found.' }

  // Refuse anything the card's current state doesn't offer, so a stale page
  // can't skip a step.
  let state
  if (deliverable === 'offer') {
    if (!job.offer_card_id) return { ok: false, error: 'This job has no offer card yet.' }
    const { data: o } = await supabase.from('offer_cards').select('stage, changes_requested_at, client_changes_requested_at').eq('id', job.offer_card_id).single()
    if (!o) return { ok: false, error: 'Offer card not found.' }
    state = offerState(o)
  } else {
    if (!job.project_id) return { ok: false, error: 'The production card is created when the client approves the offer.' }
    const { data: p } = await supabase.from('projects').select('lp_stage, lp_internal_step, lp_approved, creatives_stage, creatives_approved').eq('id', job.project_id).single()
    if (!p) return { ok: false, error: 'Production card not found.' }
    const { data: rounds } = await supabase.from('review_rounds').select('*').eq('job_id', jobId)
    state = deliverable === 'lp'
      ? trackState(p.lp_stage, p.lp_internal_step, p.lp_approved)
      : creativeState(p.creatives_stage, p.creatives_approved, (rounds ?? []) as ReviewRound[])
  }
  const spec = nextActions(deliverable, state).find(a => a.action === action)
  if (!spec) return { ok: false, error: 'That step has already moved on. Refresh the page.' }
  if (spec.needsNote && !cleanNote) return { ok: false, error: 'Say what needs to change, so the person fixing it knows.' }

  const res = deliverable === 'offer'
    ? await offerAction(supabase, job.offer_card_id!, action, name, cleanNote)
    : await productionAction(supabase, job.project_id!, job.brand_id ?? '', deliverable, action, cleanNote)
  if (!res.ok) return res

  // The round the move just closed gets the note (and so do the notices it
  // sent), if the card had nowhere to keep it.
  if (cleanNote) await supabase.rpc('annotate_review_round', { p_job: jobId, p_deliv: deliverable, p_note: cleanNote })

  revalidatePath(`/jobs/${jobId}`)
  revalidatePath('/jobs')
  revalidatePath('/my-work')
  return { ok: true }
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function offerAction(supabase: Supabase, cardId: string, action: ReviewAction, name: string, note: string): Promise<Result> {
  const now = new Date().toISOString()
  const clearApprovals = { strategist_approved_at: null, strategist_approved_by: null, engineer_approved_at: null, engineer_approved_by: null }
  let patch: Record<string, unknown>
  switch (action) {
    case 'submit': {
      const { data: o } = await supabase.from('offer_cards').select('offer, offer_description').eq('id', cardId).single()
      if (!o?.offer?.trim() && !o?.offer_description?.trim()) return { ok: false, error: 'Write the offer first (Edit the offer), then send it for review.' }
    }
      // A fresh submission is signed off from scratch.
      patch = { stage: 'internal_offer_review', changes_requested_at: null, changes_requested_by: null, changes_requested_note: null, ...clearApprovals }
      break
    case 'request_changes':
      patch = { stage: 'offer_draft', changes_requested_at: now, changes_requested_by: name, changes_requested_note: note, ...clearApprovals }
      break
    case 'approve':
      patch = { stage: 'client_review', strategist_approved_at: now, strategist_approved_by: name, changes_requested_at: null, changes_requested_by: null, changes_requested_note: null }
      break
    case 'client_changes':
      patch = { client_changes_requested_at: now, client_changes_requested_by: `Client (logged by ${name})`, client_changes_requested_note: note }
      break
    case 'resend':
      patch = { client_changes_requested_at: null, client_changes_requested_by: null, client_changes_requested_note: null }
      break
    case 'client_approve':
      // One write, so the round closes as approved (not reopened by clearing
      // the client's earlier notes first). Then the production card, exactly
      // as the client's own link creates it.
      {
        const { error } = await supabase.from('offer_cards')
          .update({ stage: 'offer_approved', client_approved_at: now, client_approved_by: `Client (logged by ${name})`, client_changes_requested_at: null, client_changes_requested_by: null, client_changes_requested_note: null })
          .eq('id', cardId)
        if (error) return { ok: false, error: error.message }
        if (autoCreateEnabled()) {
          try { await createProductionCardFromOffer(cardId, null) } catch (e) { return { ok: false, error: `Offer approved, but the production card failed: ${msg(e)}` } }
        }
        return { ok: true }
      }
    default:
      return { ok: false, error: 'Offers have no discount step.' }
  }
  const { error } = await supabase.from('offer_cards').update(patch).eq('id', cardId)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/offers')
  revalidatePath(`/offers/${cardId}`)
  return { ok: true }
}

async function productionAction(supabase: Supabase, projectId: string, brandId: string, d: 'lp' | 'creative', action: ReviewAction, note: string): Promise<Result> {
  try {
    if (d === 'lp') {
      switch (action) {
        case 'submit': return await submitLpForInternalReview(projectId, brandId)
        case 'request_changes': {
          // The LP flow needs an open internal note to send a page back; the
          // reason typed here becomes that note on the Landing Page tab.
          const added = await addLpInternalFeedback(projectId, brandId, { content: note, sectionTag: null, attachmentUrls: [] })
          if (!added.ok) return added
          return await requestLpChanges(projectId, brandId)
        }
        case 'approve': return await approveLpInternalReview(projectId, brandId)
        case 'send_client': return await sendLpToClientReview(projectId, brandId)
        case 'client_changes': await updateProjectStage(projectId, brandId, 'lp_stage', 'revisions'); return { ok: true }
        case 'resend': await updateProjectStage(projectId, brandId, 'lp_stage', 'client_review'); return { ok: true }
        case 'client_approve': {
          const { error } = await supabase.from('projects').update({ lp_approved: true, lp_stage: 'ready' }).eq('id', projectId)
          return error ? { ok: false, error: error.message } : { ok: true }
        }
      }
    } else {
      const to = { submit: 'internal_review', request_changes: 'in_progress', approve: 'client_review', client_changes: 'revisions', resend: 'client_review' } as const
      if (action === 'client_approve') {
        const { error } = await supabase.from('projects').update({ creatives_approved: true, creatives_stage: 'ready' }).eq('id', projectId)
        return error ? { ok: false, error: error.message } : { ok: true }
      }
      if (action === 'send_client') return { ok: false, error: 'Creatives have no discount step.' }
      await updateProjectStage(projectId, brandId, 'creatives_stage', to[action])
      return { ok: true }
    }
  } catch (e) {
    return { ok: false, error: msg(e) }
  }
  return { ok: false, error: 'Unknown action.' }
}

/** Edit the note on a round (e.g. add the client's exact words afterwards). */
export async function saveRoundNote(roundId: string, jobId: string, note: string): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!(await canEdit(user.email))) return { ok: false, error: 'Not authorized.' }
  const { error } = await supabase.from('review_rounds').update({ note: note.trim() || null }).eq('id', roundId).eq('job_id', jobId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/jobs/${jobId}`)
  return { ok: true }
}
