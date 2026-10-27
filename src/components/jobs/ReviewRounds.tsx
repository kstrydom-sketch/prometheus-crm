import Link from 'next/link'
import {
  DELIVERABLE_LABEL, orderRounds, REVIEW_STATE, roundLabel,
  type Deliverable, type ReviewRound, type ReviewState,
} from '@/lib/jobs/review'
import { RoundNote } from './ReviewButtons'

const day = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso)) : null

function outcomeOf(r: ReviewRound): { icon: string; cls: string; text: string } {
  if (!r.closed_at) return { icon: '…', cls: 'is-open', text: 'in review' }
  return r.outcome === 'approved'
    ? { icon: '✓', cls: 'is-ok', text: 'approved' }
    : { icon: '✗', cls: 'is-changes', text: 'changes requested' }
}

/** "Internal R1 ✗ · R2 ✓ · Client R1 ✗ · R2 …" as chips. */
export function RoundChips({ rounds, deliverable }: { rounds: ReviewRound[]; deliverable: Deliverable }) {
  const list = orderRounds(rounds, deliverable)
  if (!list.length) return <span className="mo-muted" style={{ fontSize: 13 }}>No review rounds yet</span>
  return (
    <span className="rv-chips">
      {list.map(r => {
        const o = outcomeOf(r)
        return (
          <span key={r.id} className={`rv-chip ${o.cls}`} title={`${roundLabel(r)}: ${o.text}${r.decided_label ? ` by ${r.decided_label}` : ''}${r.note ? `\n“${r.note}”` : ''}`}>
            {roundLabel(r)} <b aria-hidden>{o.icon}</b><span className="sr-only"> {o.text}</span>
          </span>
        )
      })}
    </span>
  )
}

/** One line per deliverable, at the top of the job: where each review stands. */
export function ReviewSummary({ jobId, states, rounds, stepFor }: {
  jobId: string
  states: Partial<Record<Deliverable, ReviewState>>
  rounds: ReviewRound[]
  stepFor: (d: Deliverable) => string | null
}) {
  const ds = (Object.keys(states) as Deliverable[])
  if (!ds.length) return null
  return (
    <section className="mo-panel mo-panel-pad rv-summary" aria-label="Reviews">
      <h2 className="mo-h2">Reviews</h2>
      <ul>
        {ds.map(d => {
          const st = REVIEW_STATE[states[d]!]
          const changes = rounds.filter(r => r.deliverable === d && r.outcome === 'changes').length
          const step = stepFor(d)
          return (
            <li key={d}>
              {step ? <Link href={`/jobs/${jobId}?step=${step}`} scroll={false} className="rv-name">{DELIVERABLE_LABEL[d]}</Link> : <span className="rv-name">{DELIVERABLE_LABEL[d]}</span>}
              <span className="mo-pill" style={{ color: st.fg, background: st.bg }}>{st.label}</span>
              <RoundChips rounds={rounds} deliverable={d} />
              {changes > 0 && <span className="mo-muted" style={{ fontSize: 13 }}>{changes} revision round{changes === 1 ? '' : 's'}</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Every round of one deliverable, newest first, with who decided and why. */
export function RoundTimeline({ jobId, rounds, deliverable }: { jobId: string; rounds: ReviewRound[]; deliverable: Deliverable }) {
  const list = orderRounds(rounds, deliverable).reverse()
  if (!list.length) return <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>No review rounds yet. The first one starts when this is sent to internal review.</p>
  return (
    <ol className="rv-timeline">
      {list.map(r => {
        const o = outcomeOf(r)
        return (
          <li key={r.id} className={o.cls}>
            <div className="rv-tl-head">
              <b>{roundLabel(r)}</b>
              <span className={`rv-chip ${o.cls}`}>{o.icon} {o.text}</span>
            </div>
            <div className="rv-tl-meta">
              {r.opened_at && <>Sent {day(r.opened_at)}{r.opened_label ? ` by ${r.opened_label}` : ''}</>}
              {r.opened_at && r.closed_at && ' · '}
              {r.closed_at && <>{o.text[0].toUpperCase() + o.text.slice(1)} {day(r.closed_at)}{r.decided_label ? ` by ${r.decided_label}` : ''}</>}
              {r.source === 'history' && <span title="Rebuilt from the old boards' history"> · from old board</span>}
            </div>
            {r.closed_at && <RoundNote roundId={r.id} jobId={jobId} note={r.note} />}
          </li>
        )
      })}
    </ol>
  )
}
