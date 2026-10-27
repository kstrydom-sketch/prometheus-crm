import Link from 'next/link'
import type { CardWork } from '@/lib/jobs/card-work'
import { DELIVERABLE_LABEL, nextActions, REVIEW_STATE, stepDeliverable, type Deliverable } from '@/lib/jobs/review'
import { ReviewButtons } from './ReviewButtons'
import { RoundTimeline } from './ReviewRounds'

// The work behind a linked step, inside the job page: what was the old offer
// and production boards' content, plus the review loop and its next moves.

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null
  return <><span>{label}</span><div className="sw-value">{value}</div></>
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <li className={ok ? 'is-ok' : ''}><span aria-hidden>{ok ? '✓' : '○'}</span> {children}</li>
}

export default function StepWork({ jobId, brandId, stepKey, work }: { jobId: string; brandId: string | null; stepKey: string | null; work: CardWork }) {
  const d = stepDeliverable(stepKey)
  const projectHref = brandId && work.project ? `/brands/${brandId}/projects/${work.project.id}` : null

  if (stepKey === 'brief') return <BriefWork work={work} projectHref={projectHref} />
  if (stepKey === 'launch') return <LaunchWork work={work} projectHref={projectHref} />
  if (!d) return null

  const state = work.states[d]
  if (!state) {
    return (
      <div className="sw">
        <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>
          {d === 'offer' ? 'No offer card is linked to this job.' : 'The production card is created automatically when the client approves the offer.'}
        </p>
      </div>
    )
  }
  const st = REVIEW_STATE[state]
  const actions = nextActions(d, state)

  return (
    <div className="sw">
      <div className="sw-head">
        <span className="sw-kicker">{DELIVERABLE_LABEL[d]}</span>
        <span className="mo-pill" style={{ color: st.fg, background: st.bg }}>{st.label}</span>
      </div>
      <p className="mo-muted" style={{ margin: 0, fontSize: 13.5 }}>This step moves with the review below. Set its owner and due date as usual.</p>

      <ReviewButtons jobId={jobId} deliverable={d} actions={actions} />
      {d === 'lp' && state === 'discount' && !work.project?.discount && (
        <p className="sw-warn">Record how the discount was set up on the Landing Page tab before it can go to the client.</p>
      )}

      {d === 'offer' && <OfferDetails work={work} />}
      {d === 'lp' && <LpDetails work={work} />}
      {d === 'creative' && <CreativeDetails work={work} />}

      <div className="mo-row" style={{ gap: 14, fontSize: 14 }}>
        {d === 'offer' && work.offer && <Link href={`/offers/${work.offer.id}`} className="mo-crumb">Edit the offer →</Link>}
        {d === 'offer' && work.clientOfferLink && <Link href={work.clientOfferLink} className="mo-crumb" target="_blank">Client approval link ↗</Link>}
        {d !== 'offer' && projectHref && <Link href={`${projectHref}${d === 'lp' ? (state === 'discount' ? '#discount' : '#checklist') : '#review'}`} className="mo-crumb">Open the {d === 'lp' ? 'Landing Page' : 'Creatives'} tab →</Link>}
        {d !== 'offer' && work.project?.share_token && <Link href={`/review/${work.project.share_token}`} className="mo-crumb" target="_blank">Client review link ↗</Link>}
      </div>

      <details open={state !== 'approved'}>
        <summary className="sw-summary">Review rounds</summary>
        <RoundTimeline jobId={jobId} rounds={work.rounds} deliverable={d as Deliverable} />
      </details>
    </div>
  )
}

function OfferDetails({ work }: { work: CardWork }) {
  const o = work.offer
  if (!o) return null
  return (
    <>
      {o.changes_requested_note && <p className="sw-warn"><b>Internal notes:</b> {o.changes_requested_note}</p>}
      {o.client_changes_requested_note && <p className="sw-warn"><b>Client notes:</b> {o.client_changes_requested_note}</p>}
      <div className="mo-field sw-fields">
        <Field label="Offer" value={o.offer} />
        <Field label="Type" value={o.offer_dynamics_type} />
        <Field label="Details" value={o.offer_description} />
        <Field label="Product" value={o.product_featured} />
        <Field label="Price" value={o.retail_price} />
        <Field label="Page type" value={o.page_type} />
        <Field label="Problem" value={o.problem_statement} />
        <Field label="Success" value={[o.success_metric, o.success_target].filter(Boolean).join(': ') || null} />
        <Field label="Guardrails" value={o.guardrails} />
        <Field label="Signed off" value={[o.strategist_approved_by, o.engineer_approved_by].filter(Boolean).join(' + ') || null} />
      </div>
      {!o.offer && <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>The offer hasn’t been written yet.</p>}
      {o.client_approval_message && (
        <details><summary className="sw-summary">Message to the client</summary><p className="sw-value" style={{ margin: '8px 0 0' }}>{o.client_approval_message}</p></details>
      )}
      {work.otherOffers.length > 0 && (
        <p className="mo-muted" style={{ margin: 0, fontSize: 13.5 }}>
          Other offers for this job: {work.otherOffers.map((x, i) => <span key={x.id}>{i > 0 && ', '}<Link href={`/offers/${x.id}`} className="mo-crumb">{x.name}</Link></span>)}
        </p>
      )}
    </>
  )
}

function LpDetails({ work }: { work: CardWork }) {
  const p = work.project
  if (!p) return null
  const c = p.checklist
  return (
    <>
      <div className="mo-field sw-fields">
        <Field label="Page" value={p.lp_url} />
        <Field label="Moment code" value={p.moment_code} />
        <span>Discount</span><div>{p.discount ? `${p.discount.mode === 'team' ? 'We set it up' : p.discount.mode === 'client' ? 'Client sets it up' : 'No discount'} · ${p.discount.by}` : <span className="mo-muted">Not recorded yet</span>}</div>
        <span>Notes open</span><div>{p.lpInternalOpen} internal · {p.lpClientOpen} from the client</div>
      </div>
      <details>
        <summary className="sw-summary">Checklist · {c.done} of {c.total}</summary>
        <ul className="sw-checks">{c.rows.map(r => <Check key={r.key} ok={r.done}>{r.label}</Check>)}</ul>
      </details>
    </>
  )
}

function CreativeDetails({ work }: { work: CardWork }) {
  const p = work.project
  if (!p) return null
  const a = p.assets
  return (
    <div className="mo-field sw-fields">
      <span>Creatives</span><div>{a.total ? `${a.total} in the folder` : <span className="mo-muted">None synced from Drive yet</span>}</div>
      {a.total > 0 && <><span>Internal</span><div>{a.internalApproved} approved · {a.needsRevision} need revision</div></>}
      {a.total > 0 && <><span>Client</span><div>{a.clientVisible} visible · {a.clientApproved} approved · {p.creativeClientOpen} notes open</div></>}
      <span>Ad copy</span><div>{p.copy.approved} lines approved · {p.copy.rejected} rejected</div>
      <Field label="Drive" value={p.drive_folder_url} />
    </div>
  )
}

function BriefWork({ work, projectHref }: { work: CardWork; projectHref: string | null }) {
  const p = work.project
  return (
    <div className="sw">
      <span className="sw-kicker">Brief</span>
      {!p ? (
        <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>The brief starts once the client approves the offer and the production card exists.</p>
      ) : (
        <>
          <p className="mo-muted" style={{ margin: 0, fontSize: 13.5 }}>Done once building starts on the landing page or creatives.</p>
          <ul className="sw-checks">
            <Check ok={p.briefs.some(b => b.track === 'lp')}>Landing page brief uploaded</Check>
            <Check ok={p.briefs.some(b => b.track === 'creative')}>Creative brief uploaded</Check>
          </ul>
          {p.briefs.length > 0 && <p className="mo-muted" style={{ margin: 0, fontSize: 13.5 }}>{p.briefs.map(b => b.file_name).join(' · ')}</p>}
          {projectHref && <Link href={projectHref} className="mo-crumb">Open the production card →</Link>}
        </>
      )}
    </div>
  )
}

function LaunchWork({ work, projectHref }: { work: CardWork; projectHref: string | null }) {
  const p = work.project
  return (
    <div className="sw">
      <span className="sw-kicker">Launch</span>
      <ul className="sw-checks">
        <Check ok={work.states.lp === 'approved'}>Landing page approved by the client</Check>
        <Check ok={work.states.creative === 'approved'}>Creatives approved by the client</Check>
        <Check ok={!!p?.moment_code}>Moment code for the ad names{p?.moment_code ? `: ${p.moment_code}` : ''}</Check>
        <Check ok={!!p?.launchedOn}>Launch date recorded on the Results tab</Check>
      </ul>
      <p className="mo-muted" style={{ margin: 0, fontSize: 13.5 }}>Done when both are set to Live on the production card.</p>
      {projectHref && <Link href={projectHref} className="mo-crumb">Open the production card →</Link>}
    </div>
  )
}
