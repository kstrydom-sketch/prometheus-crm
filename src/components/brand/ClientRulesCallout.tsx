import Link from 'next/link'
import { RULE_AREAS, RULES_FOR, timesTold, type RuleSurface, type RuleWithMentions } from '@/lib/brands/profile'
import './brand.css'

// The client's standing feedback, read-only, at the top of any screen where
// work for them is planned, made or checked. Only the rules for this kind of
// work. Rules are added and changed on the brand page; this links there.
//
// No hooks and no server-only imports, so both server pages and the client
// project view can render it.

export default function ClientRulesCallout({
  brandId, brandName, rules, surface, title, compact = false,
}: {
  brandId: string
  brandName: string
  rules: RuleWithMentions[]
  surface: RuleSurface
  /** Defaults to "{brand} has told us". */
  title?: string
  /** Fewer words in the empty state, for side panels. */
  compact?: boolean
}) {
  const areas: readonly string[] = RULES_FOR[surface]
  const shown = rules
    .filter(r => r.status === 'active' && areas.includes(r.area))
    // Things they have had to repeat go first: those are the ones we keep missing.
    .sort((a, b) => timesTold(b) - timesTold(a) || areas.indexOf(a.area) - areas.indexOf(b.area))

  return (
    <section className="cr-callout" aria-label="Client rules">
      <div className="cr-callout-head">
        <h3 className="cr-callout-title">{title ?? `${brandName} has told us`} {shown.length > 0 && <span className="cr-count">· {shown.length}</span>}</h3>
        <Link href={`/brands/${brandId}#client-rules`} className="bp-link">All client rules →</Link>
      </div>
      {shown.length === 0 ? (
        <p className="bp-empty">
          {compact
            ? 'No standing feedback recorded yet.'
            : 'No standing feedback recorded for this kind of work yet. When the client gives feedback that applies beyond one piece, save it as a client rule so nobody has to hear it twice.'}
        </p>
      ) : (
        <ul>
          {shown.map(r => {
            const n = timesTold(r)
            return (
              <li key={r.id}>
                <span className="cr-area">{RULE_AREAS[r.area].label}</span>
                {n > 1 && <span className="cr-told cr-told-again" title={`The client has told us this ${n} times`}>Told us {n}×</span>}
                <span>{r.rule}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
