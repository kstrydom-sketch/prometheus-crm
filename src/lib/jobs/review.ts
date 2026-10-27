// Review rounds: shared types and labels for the offer, landing page and
// creatives loops (20261030_review_rounds.sql). Safe for server and browser.
//
//   building → internal review ⇄ internal revisions requested
//            → client review   ⇄ client revisions requested → approved
//
// The cards hold the work and the gates; the database turns every card move
// into rounds and step statuses. A linked step's status is never set by hand.

import type { Job, JobStep } from './model'

export type Deliverable = 'offer' | 'lp' | 'creative'
export type ReviewPhase = 'internal' | 'client'
export type ReviewState =
  | 'not_started' | 'building' | 'internal_review' | 'internal_revisions'
  | 'discount' | 'client_review' | 'client_revisions' | 'approved'

export interface ReviewRound {
  id: string
  job_id: string
  deliverable: Deliverable
  phase: ReviewPhase
  round_no: number
  opened_at: string | null
  opened_label: string | null
  closed_at: string | null
  outcome: 'approved' | 'changes' | null
  decided_label: string | null
  note: string | null
  source: 'live' | 'history'
}

export const DELIVERABLES: Deliverable[] = ['offer', 'lp', 'creative']
export const DELIVERABLE_LABEL: Record<Deliverable, string> = { offer: 'Offer', lp: 'Landing page', creative: 'Creatives' }

export const REVIEW_STATE: Record<ReviewState, { label: string; fg: string; bg: string }> = {
  not_started:        { label: 'Not started',                 fg: '#5C5346', bg: 'rgba(92, 83, 70, 0.10)' },
  building:           { label: 'Being made',                  fg: '#1D4ED8', bg: 'rgba(59, 130, 246, 0.14)' },
  internal_review:    { label: 'Ready for internal review',   fg: '#4338CA', bg: 'rgba(99, 102, 241, 0.14)' },
  internal_revisions: { label: 'Internal revisions requested', fg: '#BE123C', bg: 'rgba(244, 63, 94, 0.14)' },
  discount:           { label: 'Discount creation',           fg: '#6D28D9', bg: 'rgba(139, 92, 246, 0.14)' },
  client_review:      { label: 'With the client',             fg: '#92400E', bg: 'rgba(245, 158, 11, 0.18)' },
  client_revisions:   { label: 'Client revisions requested',  fg: '#BE123C', bg: 'rgba(244, 63, 94, 0.14)' },
  approved:           { label: 'Approved',                    fg: '#3F6212', bg: 'rgba(101, 163, 13, 0.18)' },
}

// Which deliverable a linked step belongs to. brief and launch follow the
// production card too, but belong to no single loop.
const STEP_DELIVERABLE: Record<string, Deliverable> = {
  offer_draft: 'offer', offer_internal_review: 'offer', offer_client_approval: 'offer', offer_revisions: 'offer',
  lp_build: 'lp', lp_internal_review: 'lp', lp_discount: 'lp', lp_client_review: 'lp', lp_revisions: 'lp',
  cr_drafts: 'creative', cr_internal_review: 'creative', cr_client_review: 'creative', cr_revisions: 'creative',
}

export function stepDeliverable(key: string | null): Deliverable | null {
  return key ? STEP_DELIVERABLE[key] ?? null : null
}

/** The step's status follows a card, so nobody sets it by hand. */
export function isLinkedStep(step: Pick<JobStep, 'key'>, job: Pick<Job, 'offer_card_id' | 'project_id'>): boolean {
  const d = stepDeliverable(step.key)
  if (d === 'offer') return !!job.offer_card_id
  if (d || step.key === 'brief' || step.key === 'launch') return !!job.project_id
  return false
}

// Same rules as offer_review_state / track_review_state in the migration.
export function offerState(o: { stage: string; changes_requested_at: string | null; client_changes_requested_at: string | null }): ReviewState {
  switch (o.stage) {
    case 'offer_draft': return o.changes_requested_at ? 'internal_revisions' : 'building'
    case 'internal_offer_review': return 'internal_review'
    case 'client_review': return o.client_changes_requested_at ? 'client_revisions' : 'client_review'
    case 'offer_approved': return 'approved'
    default: return 'not_started'
  }
}

export function trackState(stage: string | null, internalStep: string | null, approved: boolean | null): ReviewState {
  if (approved || stage === 'ready' || stage === 'live') return 'approved'
  if (stage === 'in_progress') return 'building'
  if (stage === 'internal_review') return internalStep === 'revisions' ? 'internal_revisions' : internalStep === 'discount' ? 'discount' : 'internal_review'
  if (stage === 'client_review') return 'client_review'
  if (stage === 'revisions') return 'client_revisions'
  return 'not_started'
}

/** Creatives go back to In Progress after internal changes; the rounds tell them apart. */
export function creativeState(stage: string | null, approved: boolean | null, rounds: ReviewRound[]): ReviewState {
  const st = trackState(stage, null, approved)
  if (st !== 'building') return st
  const mine = rounds.filter(r => r.deliverable === 'creative')
  const lastInternal = mine.filter(r => r.phase === 'internal').sort((a, b) => b.round_no - a.round_no)[0]
  return lastInternal?.outcome === 'changes' && !mine.some(r => r.phase === 'client') ? 'internal_revisions' : st
}

/** Rounds in the order they happened: internal ones, then client ones. */
export function orderRounds(rounds: ReviewRound[], d: Deliverable): ReviewRound[] {
  return rounds
    .filter(r => r.deliverable === d)
    .sort((a, b) => (a.phase === b.phase ? a.round_no - b.round_no : a.phase === 'internal' ? -1 : 1))
}

export function roundLabel(r: Pick<ReviewRound, 'phase' | 'round_no'>): string {
  return `${r.phase === 'internal' ? 'Internal' : 'Client'} R${r.round_no}`
}

// ── What can be done next, from the job page ────────────────────────────────
export type ReviewAction =
  | 'submit' | 'request_changes' | 'approve' | 'send_client'
  | 'client_changes' | 'resend' | 'client_approve'

export interface ActionSpec { action: ReviewAction; label: string; needsNote?: boolean; tone: 'primary' | 'secondary' | 'danger' }

export function nextActions(d: Deliverable, state: ReviewState): ActionSpec[] {
  switch (state) {
    case 'not_started':
    case 'building':
      return [{ action: 'submit', label: 'Send to internal review', tone: 'primary' }]
    case 'internal_review':
      return [
        { action: 'approve', label: d === 'lp' ? 'Approve (then discount)' : 'Approve and send to client', tone: 'primary' },
        { action: 'request_changes', label: 'Request internal revisions', needsNote: true, tone: 'danger' },
      ]
    case 'internal_revisions':
      return d === 'lp'
        ? [{ action: 'submit', label: 'Revisions done: back to internal review', tone: 'primary' }, { action: 'approve', label: 'Approve as is', tone: 'secondary' }]
        : [{ action: 'submit', label: 'Revisions done: back to internal review', tone: 'primary' }]
    case 'discount':
      return [{ action: 'send_client', label: 'Send to client', tone: 'primary' }]
    case 'client_review':
      return [
        { action: 'client_approve', label: 'Client approved', tone: 'primary' },
        { action: 'client_changes', label: 'Client asked for revisions', needsNote: true, tone: 'danger' },
      ]
    case 'client_revisions':
      return [
        { action: 'resend', label: 'Revisions done: back to the client', tone: 'primary' },
        { action: 'client_approve', label: 'Client approved', tone: 'secondary' },
      ]
    case 'approved':
      return []
  }
}
