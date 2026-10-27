import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedProfiles } from '@/lib/profiles'
import { profileName } from '@/lib/types'
import { canEditTemplates } from '@/lib/permissions'
import {
  DONE_STAGE, formatDue, isOpen, isOverdue, jobStage, orderSteps, stageInfo, stepStatusStyle, todayIso,
  type Job, type JobStep, type WorkflowTemplate,
} from '@/lib/jobs/model'
import { NewWorkButtons } from '@/components/jobs/JobControls'
import '@/components/jobs/jobs.css'

type Filter = 'active' | 'mine' | 'late' | 'all'
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'mine', label: 'I own or follow' },
  { key: 'late', label: 'Behind schedule' },
  { key: 'all', label: 'All' },
]
const TASKS = 'tasks'

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ show?: string; type?: string; stage?: string }> }) {
  const { show, type: typeParam, stage: stageParam } = await searchParams
  const filter: Filter = (FILTERS.find(f => f.key === show)?.key) ?? 'active'
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const supabase = await createClient()
  const profiles = await getCachedProfiles()
  const me = profiles.find(p => p.email === user.email?.toLowerCase())
  const nameOf = (id: string | null) => profiles.find(p => p.id === id)?.full_name ?? 'Unassigned'

  const [{ data: jobsRaw }, { data: stepsRaw }, { data: brandsRaw }, { data: followRaw }, { data: templatesRaw }] = await Promise.all([
    supabase.from('jobs').select('*, brands(name)').order('due_date', { ascending: true, nullsFirst: false }),
    supabase.from('job_steps').select('id, job_id, parent_id, key, title, is_group, sort_order, assignee_id, due_date, status, stage'),
    supabase.from('brands').select('id, name').eq('is_active', true).order('name'),
    me ? supabase.from('job_followers').select('job_id').eq('profile_id', me.id) : Promise.resolve({ data: [] }),
    supabase.from('workflow_templates').select('*').order('sort_order').order('name'),
  ])
  const jobs = (jobsRaw ?? []) as unknown as Array<Job & { brands: { name: string } | null }>
  const steps = (stepsRaw ?? []) as JobStep[]
  const templates = (templatesRaw ?? []) as WorkflowTemplate[]
  const followed = new Set((followRaw ?? []).map(f => f.job_id))
  const today = todayIso()

  const typeTemplate = templates.find(t => t.id === typeParam) ?? null
  const typeFilter = typeTemplate ? typeTemplate.id : typeParam === TASKS ? TASKS : null
  const typeOf = (j: Job) => (j.kind === 'task' ? TASKS : j.template_id)

  const byFilter = jobs.map(j => {
    const mine = orderSteps(steps.filter(s => s.job_id === j.id)).filter(s => !s.is_group)
    const done = mine.filter(s => !isOpen(s.status)).length
    const late = mine.filter(s => isOverdue(s, today))
    const next = mine.find(s => isOpen(s.status))
    const stage = jobStage(j.stages, mine)
    return { j, total: mine.length, done, late, next, stage }
  }).filter(r => {
    if (filter === 'active') return r.j.status === 'active' || r.j.status === 'on_hold'
    if (filter === 'mine') return r.j.owner_id === me?.id || followed.has(r.j.id)
    if (filter === 'late') return r.late.length > 0 && r.j.status === 'active'
    return true
  })
  const typeCounts = byFilter.reduce((acc, r) => {
    const k = typeOf(r.j) ?? ''
    return { ...acc, [k]: (acc[k] ?? 0) + 1 }
  }, {} as Record<string, number>)
  const rows = typeFilter ? byFilter.filter(r => typeOf(r.j) === typeFilter) : byFilter

  // Stage chips come from the chosen workflow's current stages (plus its done
  // label). Jobs made from an older version keep their own stages; they still
  // show under "Any stage" if a stage was renamed or removed since.
  const stageKeys = typeTemplate ? [...typeTemplate.stages.map(s => s.key), DONE_STAGE] : []
  const stageFilter = stageKeys.find(k => k === stageParam) ?? null
  const stageCounts = rows.reduce((acc, r) => (r.stage ? { ...acc, [r.stage]: (acc[r.stage] ?? 0) + 1 } : acc), {} as Record<string, number>)
  const shown = stageFilter ? rows.filter(r => r.stage === stageFilter) : rows

  const href = (q: { show?: Filter; type?: string | null; stage?: string | null }) => {
    const params = new URLSearchParams({ show: q.show ?? filter })
    const ty = 'type' in q ? q.type : typeFilter
    if (ty) params.set('type', ty)
    const st = 'stage' in q ? q.stage : 'type' in q ? null : stageFilter
    if (st) params.set('stage', st)
    return `/jobs?${params}`
  }
  const live = templates.filter(t => !t.archived_at)
  const typeChips = [
    ...templates.filter(t => !t.archived_at || typeCounts[t.id]).map(t => ({ key: t.id, label: t.name })),
    { key: TASKS, label: 'One-off tasks' },
  ]

  return (
    <div className="mo-page">
      <div className="mo-spread">
        <div>
          <h1 className="mo-h1">Jobs</h1>
          <p className="mo-sub">
            Every piece of client and internal work, with an owner and a due date on each step.{' '}
            <Link href="/jobs/templates" className="mo-crumb" style={{ textDecoration: 'underline' }}>
              {canEditTemplates(user.email) ? 'Manage workflows' : 'See workflows'}
            </Link>
          </p>
        </div>
        <NewWorkButtons
          brands={brandsRaw ?? []}
          people={profiles.filter(p => p.can_edit).map(p => ({ id: p.id, name: profileName(p) }))}
          defaultOwner={me?.id ?? null}
          templates={live.map(t => ({ id: t.id, name: t.name, description: t.description, uses_month_slot: t.uses_month_slot, due_label: t.due_label, steps: t.steps, stages: t.stages }))}
          defaultTemplate={typeTemplate && !typeTemplate.archived_at ? typeTemplate.id : null}
        />
      </div>

      <nav className="mo-tabs" aria-label="Filter jobs">
        {FILTERS.map(f => (
          <Link key={f.key} href={href({ show: f.key })} className="mo-tab" aria-current={f.key === filter ? 'page' : undefined}>{f.label}</Link>
        ))}
      </nav>

      <nav className="mo-tabs" aria-label="Filter by workflow" style={{ marginTop: -8 }}>
        <Link href={href({ type: null })} className="mo-tab mo-tab-sm" aria-current={!typeFilter ? 'page' : undefined}>Every type · {byFilter.length}</Link>
        {typeChips.map(t => (
          <Link key={t.key} href={href({ type: t.key })} className="mo-tab mo-tab-sm" aria-current={t.key === typeFilter ? 'page' : undefined}
            style={{ opacity: typeCounts[t.key] || t.key === typeFilter ? 1 : 0.55 }}>
            {t.label} · {typeCounts[t.key] ?? 0}
          </Link>
        ))}
      </nav>

      {typeTemplate && (
        <nav className="mo-tabs" aria-label="Filter by stage" style={{ marginTop: -8 }}>
          <Link href={href({ stage: null })} className="mo-tab mo-tab-sm" aria-current={!stageFilter ? 'page' : undefined}>Any stage · {rows.length}</Link>
          {stageKeys.map(k => {
            const info = stageInfo(typeTemplate.stages, k, typeTemplate.done_label)
            return (
              <Link key={k} href={href({ stage: k })} className="mo-tab mo-tab-sm" aria-current={k === stageFilter ? 'page' : undefined}
                style={k === stageFilter ? undefined : { color: info.fg, background: info.bg, borderColor: 'transparent', opacity: stageCounts[k] ? 1 : 0.5 }}>
                {info.label} · {stageCounts[k] ?? 0}
              </Link>
            )
          })}
        </nav>
      )}

      <section className="mo-panel">
        {shown.length === 0 ? (
          <p className="mo-empty">
            {stageFilter && typeTemplate
              ? `No ${typeTemplate.name.toLowerCase()} jobs in ${stageInfo(typeTemplate.stages, stageFilter, typeTemplate.done_label).label} with this filter.`
              : 'Nothing here yet. “+ New job” starts a workflow with every step and its due date; “+ New task” is for one-off work.'}
          </p>
        ) : (
          <ul className="mo-list">
            {shown.map(({ j, total, done, late, next, stage }) => {
              const info = stage ? stageInfo(j.stages, stage, j.done_label) : null
              const typeName = j.kind === 'task' ? 'Task' : templates.find(t => t.id === j.template_id)?.name ?? 'Workflow'
              const client = j.brands?.name ?? 'Internal'
              return (
                <li key={j.id} style={{ gridTemplateColumns: 'minmax(220px, 2fr) minmax(240px, 2fr) minmax(130px, 1fr) auto' }}>
                  <div>
                    <Link href={`/jobs/${j.id}`} style={{ fontWeight: 700, fontSize: 16 }}>{j.name}</Link>
                    <div className="mo-muted" style={{ fontSize: 14 }}>
                      {typeName}{j.kind === 'task' ? ` · ${client}` : ''} · {nameOf(j.owner_id)} · {j.due_label} {formatDue(j.due_date)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                    {info && <span className="mo-pill" style={{ fontSize: 14, color: info.fg, background: info.bg }}>{info.label}</span>}
                    {j.kind === 'task' ? (
                      next
                        ? <span style={{ color: stepStatusStyle(next.status).fg, fontWeight: 600, fontSize: 13 }}>{stepStatusStyle(next.status).label}</span>
                        : <span className="mo-muted" style={{ fontSize: 13 }}>Done</span>
                    ) : next ? (
                      <span style={{ fontSize: 13 }}>
                        <span className="mo-muted">Next: </span>
                        <Link href={`/jobs/${j.id}?step=${next.id}`}>{next.title}</Link>
                        <span className="mo-muted"> · {nameOf(next.assignee_id)} · {formatDue(next.due_date)} · </span>
                        <span style={{ color: stepStatusStyle(next.status).fg, fontWeight: 600 }}>{stepStatusStyle(next.status).label}</span>
                      </span>
                    ) : <span className="mo-muted" style={{ fontSize: 13 }}>All steps done</span>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {j.kind !== 'task' && (
                      <>
                        <div className="mo-progress" aria-label={`${done} of ${total} steps done`}><span style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
                        <span className="mo-muted" style={{ fontSize: 13 }}>{done} of {total} steps done</span>
                      </>
                    )}
                  </div>
                  <div>{late.length > 0 && <span className="mo-pill mo-late">{j.kind === 'task' ? 'Late' : `${late.length} late`}</span>}</div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
