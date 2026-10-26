import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedProfiles } from '@/lib/profiles'
import { profileName } from '@/lib/types'
import {
  formatDue, isOpen, isOverdue, MOMENT_STAGE, momentStage, orderSteps, STEP_STATUS, todayIso,
  type Moment, type MomentStage as MomentStageKey, type MomentStep,
} from '@/lib/moments/model'
import { NewMomentForm } from '@/components/moments/MomentControls'
import '@/components/moments/moments.css'

type Filter = 'active' | 'mine' | 'late' | 'all'
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'mine', label: 'I own or follow' },
  { key: 'late', label: 'Behind schedule' },
  { key: 'all', label: 'All' },
]

export default async function MomentsPage({ searchParams }: { searchParams: Promise<{ show?: string; stage?: string }> }) {
  const { show, stage: stageParam } = await searchParams
  const filter: Filter = (FILTERS.find(f => f.key === show)?.key) ?? 'active'
  const stageFilter = (Object.keys(MOMENT_STAGE) as MomentStageKey[]).find(k => k === stageParam) ?? null
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const supabase = await createClient()
  const profiles = await getCachedProfiles()
  const me = profiles.find(p => p.email === user.email?.toLowerCase())
  const nameOf = (id: string | null) => profiles.find(p => p.id === id)?.full_name ?? 'Unassigned'

  const [{ data: momentsRaw }, { data: stepsRaw }, { data: brandsRaw }, { data: followRaw }] = await Promise.all([
    supabase.from('moments').select('*, brands(name)').order('launch_date', { ascending: true }),
    supabase.from('moment_steps').select('id, moment_id, parent_id, key, title, is_group, sort_order, assignee_id, due_date, status'),
    supabase.from('brands').select('id, name').eq('is_active', true).order('name'),
    me ? supabase.from('moment_followers').select('moment_id').eq('profile_id', me.id) : Promise.resolve({ data: [] }),
  ])
  const moments = (momentsRaw ?? []) as unknown as Array<Moment & { brands: { name: string } | null }>
  const steps = (stepsRaw ?? []) as MomentStep[]
  const followed = new Set((followRaw ?? []).map(f => f.moment_id))
  const today = todayIso()

  const rows = moments.map(m => {
    const mine = orderSteps(steps.filter(s => s.moment_id === m.id)).filter(s => !s.is_group)
    const done = mine.filter(s => !isOpen(s.status)).length
    const late = mine.filter(s => isOverdue(s, today))
    const next = mine.find(s => isOpen(s.status))
    const stage = momentStage(mine)
    return { m, total: mine.length, done, late, next, stage }
  }).filter(r => {
    if (filter === 'active') return r.m.status === 'active' || r.m.status === 'on_hold'
    if (filter === 'mine') return r.m.owner_id === me?.id || followed.has(r.m.id)
    if (filter === 'late') return r.late.length > 0 && r.m.status === 'active'
    return true
  })
  // Stage counts reflect the filter above, so each chip says what you'd get.
  const stageCounts = rows.reduce((acc, r) => ({ ...acc, [r.stage]: (acc[r.stage] ?? 0) + 1 }), {} as Partial<Record<MomentStageKey, number>>)
  const shown = stageFilter ? rows.filter(r => r.stage === stageFilter) : rows
  const href = (q: { show?: Filter; stage?: MomentStageKey | null }) => {
    const params = new URLSearchParams({ show: q.show ?? filter })
    const st = 'stage' in q ? q.stage : stageFilter
    if (st) params.set('stage', st)
    return `/moments?${params}`
  }

  return (
    <div className="mo-page">
      <div className="mo-spread">
        <div>
          <h1 className="mo-h1">Moments</h1>
          <p className="mo-sub">One per client moment. Every step from offer to launch, with an owner and a due date.</p>
        </div>
        <NewMomentForm brands={brandsRaw ?? []} people={profiles.filter(p => p.can_edit).map(p => ({ id: p.id, name: profileName(p) }))} defaultOwner={me?.id ?? null} />
      </div>

      <nav className="mo-tabs" aria-label="Filter moments">
        {FILTERS.map(f => (
          <Link key={f.key} href={href({ show: f.key })} className="mo-tab" aria-current={f.key === filter ? 'page' : undefined}>{f.label}</Link>
        ))}
      </nav>

      <nav className="mo-tabs" aria-label="Filter by stage" style={{ marginTop: -8 }}>
        <Link href={href({ stage: null })} className="mo-tab mo-tab-sm" aria-current={!stageFilter ? 'page' : undefined}>Any stage · {rows.length}</Link>
        {(Object.keys(MOMENT_STAGE) as MomentStageKey[]).map(k => (
          <Link key={k} href={href({ stage: k })} className="mo-tab mo-tab-sm" aria-current={k === stageFilter ? 'page' : undefined}
            style={k === stageFilter ? undefined : { color: MOMENT_STAGE[k].fg, background: MOMENT_STAGE[k].bg, borderColor: 'transparent', opacity: stageCounts[k] ? 1 : 0.5 }}>
            {MOMENT_STAGE[k].label} · {stageCounts[k] ?? 0}
          </Link>
        ))}
      </nav>

      <section className="mo-panel">
        {shown.length === 0 ? (
          <p className="mo-empty">{stageFilter ? `No moments in ${MOMENT_STAGE[stageFilter].label} with this filter.` : 'No moments here yet. Create one with “+ New moment”: it comes with every step and its due date.'}</p>
        ) : (
          <ul className="mo-list">
            {shown.map(({ m, total, done, late, next, stage }) => (
              <li key={m.id} style={{ gridTemplateColumns: 'minmax(220px, 2fr) minmax(240px, 2fr) minmax(130px, 1fr) auto' }}>
                <div>
                  <Link href={`/moments/${m.id}`} style={{ fontWeight: 700, fontSize: 16 }}>{m.name}</Link>
                  <div className="mo-muted" style={{ fontSize: 14 }}>Owner: {nameOf(m.owner_id)} · Launch {formatDue(m.launch_date)}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                  <span className="mo-pill" style={{ fontSize: 14, color: MOMENT_STAGE[stage].fg, background: MOMENT_STAGE[stage].bg }}>{MOMENT_STAGE[stage].label}</span>
                  {next ? (
                    <span style={{ fontSize: 13 }}>
                      <span className="mo-muted">Next: </span>
                      <Link href={`/moments/${m.id}?step=${next.id}`}>{next.title}</Link>
                      <span className="mo-muted"> · {nameOf(next.assignee_id)} · {formatDue(next.due_date)} · </span>
                      <span style={{ color: STEP_STATUS[next.status].fg, fontWeight: 600 }}>{STEP_STATUS[next.status].label}</span>
                    </span>
                  ) : <span className="mo-muted" style={{ fontSize: 13 }}>All steps done</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="mo-progress" aria-label={`${done} of ${total} steps done`}><span style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
                  <span className="mo-muted" style={{ fontSize: 13 }}>{done} of {total} steps done</span>
                </div>
                <div>{late.length > 0 && <span className="mo-pill mo-late">{late.length} late</span>}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
