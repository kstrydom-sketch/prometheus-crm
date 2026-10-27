// What the job page shows from the offer and production cards: the work itself
// (offer brief, landing page, creatives, briefs) and where each review stands.
// Server only: reads through the signed-in client.

import type { createClient } from '@/lib/supabase/server'
import { evaluateLpChecklist, readLpDiscount, type LpChecklistResult, type LpDiscount } from '@/lib/lp-review'
import { readCopyApprovals } from '@/lib/products'
import { creativeState, offerState, trackState, type Deliverable, type ReviewRound, type ReviewState } from './review'

type Supabase = Awaited<ReturnType<typeof createClient>>

export interface OfferWork {
  id: string
  name: string
  stage: string
  offer_dynamics_type: string | null
  offer: string | null
  offer_description: string | null
  product_featured: string | null
  retail_price: string | null
  page_type: string | null
  problem_statement: string | null
  success_metric: string | null
  success_target: number | null
  guardrails: string | null
  client_approval_message: string | null
  strategist_approved_by: string | null
  engineer_approved_by: string | null
  changes_requested_note: string | null
  client_changes_requested_note: string | null
}

export interface ProjectWork {
  id: string
  name: string
  lp_url: string | null
  share_token: string | null
  drive_folder_url: string | null
  moment_code: string | null
  checklist: LpChecklistResult
  discount: LpDiscount | null
  lpInternalOpen: number
  lpClientOpen: number
  creativeClientOpen: number
  assets: { total: number; internalApproved: number; needsRevision: number; clientVisible: number; clientApproved: number }
  copy: { approved: number; rejected: number }
  briefs: { id: string; file_name: string; track: string; extraction_status: string }[]
  launchedOn: string | null
}

export interface CardWork {
  offer: OfferWork | null
  /** Other offers written for the same job. */
  otherOffers: { id: string; name: string; stage: string }[]
  project: ProjectWork | null
  rounds: ReviewRound[]
  states: Partial<Record<Deliverable, ReviewState>>
  clientOfferLink: string | null
}

export async function loadCardWork(
  supabase: Supabase,
  job: { id: string; brand_id: string | null; offer_card_id: string | null; project_id: string | null },
): Promise<CardWork> {
  const [{ data: roundsRaw }, { data: offersRaw }, { data: brand }] = await Promise.all([
    supabase.from('review_rounds').select('*').eq('job_id', job.id),
    supabase.from('offer_cards')
      .select('id, name, stage, offer_dynamics_type, offer, offer_description, product_featured, retail_price, page_type, problem_statement, success_metric, success_target, guardrails, client_approval_message, strategist_approved_by, engineer_approved_by, changes_requested_at, changes_requested_note, client_changes_requested_at, client_changes_requested_note')
      .eq('job_id', job.id),
    job.brand_id ? supabase.from('brands').select('client_token').eq('id', job.brand_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const rounds = (roundsRaw ?? []) as ReviewRound[]
  const offers = (offersRaw ?? []) as Array<OfferWork & { changes_requested_at: string | null; client_changes_requested_at: string | null }>
  const offer = offers.find(o => o.id === job.offer_card_id) ?? null
  const states: CardWork['states'] = {}
  if (offer) states.offer = offerState(offer)

  let project: ProjectWork | null = null
  if (job.project_id) {
    const pid = job.project_id
    const [{ data: p }, { data: assets }, { data: comments }, { count: liquidCount }, { data: briefs }, { data: tracking }] = await Promise.all([
      supabase.from('projects')
        .select('id, name, lp_url, share_token, drive_folder_url, moment_code, shopify_coupon_code, lp_liquid_reason, lp_checklist, lp_submission, lp_discount, lp_stage, lp_internal_step, lp_approved, creatives_stage, creatives_approved, copy_approvals')
        .eq('id', pid).single(),
      supabase.from('creative_assets').select('internal_status, status, client_visible').eq('project_id', pid).eq('is_hidden', false),
      supabase.from('project_comments').select('track, audience').eq('project_id', pid).is('resolved_at', null),
      supabase.from('lp_liquid_files').select('id', { count: 'exact', head: true }).eq('project_id', pid),
      supabase.from('project_briefs').select('id, file_name, track, extraction_status').eq('project_id', pid).order('created_at'),
      supabase.from('lp_tracking').select('launched_on').eq('project_id', pid).order('launched_on', { ascending: false }).limit(1),
    ])
    if (p) {
      const a = assets ?? []
      const c = comments ?? []
      const copy = readCopyApprovals(p)
      project = {
        id: p.id, name: p.name, lp_url: p.lp_url, share_token: p.share_token, drive_folder_url: p.drive_folder_url, moment_code: p.moment_code,
        checklist: evaluateLpChecklist(p, liquidCount ?? 0),
        discount: readLpDiscount(p.lp_discount),
        lpInternalOpen: c.filter(x => x.track === 'lp' && x.audience === 'internal').length,
        lpClientOpen: c.filter(x => x.track === 'lp' && x.audience === 'client').length,
        creativeClientOpen: c.filter(x => x.track === 'image' && x.audience === 'client').length,
        assets: {
          total: a.length,
          internalApproved: a.filter(x => x.internal_status === 'approved').length,
          needsRevision: a.filter(x => x.internal_status === 'needs_revision' || x.status === 'needs_revision').length,
          clientVisible: a.filter(x => x.client_visible).length,
          clientApproved: a.filter(x => x.status === 'approved').length,
        },
        copy: { approved: copy.lines.filter(l => l.status === 'approved').length, rejected: copy.lines.filter(l => l.status === 'rejected').length },
        briefs: briefs ?? [],
        launchedOn: tracking?.[0]?.launched_on ?? null,
      }
      states.lp = trackState(p.lp_stage, p.lp_internal_step, p.lp_approved)
      states.creative = creativeState(p.creatives_stage, p.creatives_approved, rounds)
    }
  }

  return {
    offer,
    otherOffers: offers.filter(o => o.id !== job.offer_card_id).map(o => ({ id: o.id, name: o.name, stage: o.stage })),
    project,
    rounds,
    states,
    clientOfferLink: brand?.client_token ? `/offer-approval/${brand.client_token}` : null,
  }
}
