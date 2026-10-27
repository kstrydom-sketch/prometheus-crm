import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedProfiles } from '@/lib/profiles'
import { daysBetween, formatDue, STEP_STATUS, todayIso, type InboxItem, type JobStep } from '@/lib/jobs/model'
import { StatusSelect } from '@/components/jobs/StepControls'
import { isLinkedStep } from '@/lib/jobs/review'
import { ClearAllFyiButton, ClearButton } from '@/components/jobs/JobControls'
import '@/components/jobs/jobs.css'

type MyStep = JobStep & { jobs: { id: string; name: string; status: string; kind: string; offer_card_id: string | null; project_id: string | null; brands: { name: string } | null } | null }

export default async function MyWorkPage() {
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const supabase = await createClient()
  const profiles = await getCachedProfiles()
  const me = profiles.find(p => p.email === user.email?.toLowerCase())
  if (!me) redirect('/')
  const nameOf = (id: string | null) => profiles.find(p => p.id === id)?.full_name ?? 'Someone'

  const [{ data: stepsRaw }, { data: inboxRaw }] = await Promise.all([
    supabase.from('job_steps').select('*, jobs(id, name, status, kind, offer_card_id, project_id, brands(name))')
      .eq('assignee_id', me.id).eq('is_group', false).not('status', 'in', '(done,skipped)')
      .order('due_date', { ascending: true, nullsFirst: false }),
    supabase.from('inbox_items').select('*').eq('recipient_id', me.id).is('cleared_at', null).order('created_at', { ascending: false }),
  ])
  const steps = ((stepsRaw ?? []) as MyStep[]).filter(s => s.jobs?.status === 'active' || s.jobs?.status === 'on_hold')
  const inbox = (inboxRaw ?? []) as InboxItem[]
  const today = todayIso()

  const buckets: Array<{ key: string; title: string; items: MyStep[] }> = [
    { key: 'late', title: 'Overdue', items: steps.filter(s => s.due_date && s.due_date < today) },
    { key: 'today', title: 'Due today', items: steps.filter(s => s.due_date === today) },
    { key: 'week', title: 'Next 7 days', items: steps.filter(s => s.due_date && s.due_date > today && daysBetween(today, s.due_date) <= 7) },
    { key: 'later', title: 'Later', items: steps.filter(s => s.due_date && daysBetween(today, s.due_date) > 7) },
    { key: 'none', title: 'No due date', items: steps.filter(s => !s.due_date) },
  ]
  const actions = inbox.filter(i => i.kind === 'needs_action')
  const fyis = inbox.filter(i => i.kind === 'fyi')
  const link = (i: InboxItem) => (i.job_id ? `/jobs/${i.job_id}${i.step_id ? `?step=${i.step_id}` : ''}` : '/jobs')
  const ago = (iso: string) => {
    const d = daysBetween(iso.slice(0, 10), today)
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
  }

  return (
    <div className="mo-page">
      <div>
        <h1 className="mo-h1">My work</h1>
        <p className="mo-sub">
          {buckets[0].items.length > 0 ? `${buckets[0].items.length} overdue · ` : ''}
          {buckets[1].items.length} due today · {actions.length} need{actions.length === 1 ? 's' : ''} your action
        </p>
      </div>

      <div className="mo-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {buckets.filter(b => b.items.length > 0 || b.key === 'today').map(b => (
            <section key={b.key} className="mo-panel" aria-label={b.title}>
              <div className="mo-section-title" style={b.key === 'late' ? { color: '#B91C1C' } : undefined}>
                <span>{b.title}</span><span className="mo-count">{b.items.length}</span>
              </div>
              {b.items.length === 0 ? <p className="mo-empty">Nothing due today.</p> : (
                <ul className="mo-list">
                  {b.items.map(s => (
                    <li key={s.id} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}>
                      <div>
                        <Link href={`/jobs/${s.job_id}?step=${s.id}`} style={{ fontWeight: 600 }}>{s.title}</Link>
                        <div className="mo-muted" style={{ fontSize: 14 }}>{s.jobs?.kind === 'task' ? `Task · ${s.jobs.brands?.name ?? 'Internal'}` : s.jobs?.name}</div>
                      </div>
                      <span style={{ fontSize: 14, fontWeight: b.key === 'late' ? 700 : 500, color: b.key === 'late' ? '#B91C1C' : 'var(--text-secondary)' }}>
                        {formatDue(s.due_date)}{b.key === 'late' && s.due_date ? ` · ${daysBetween(s.due_date, today)}d late` : ''}
                      </span>
                      {s.jobs && isLinkedStep(s, s.jobs)
                        ? <Link href={`/jobs/${s.job_id}?step=${s.id}`} className="mo-pill" title="Moves with the review: open it to act" style={{ color: STEP_STATUS[s.status].fg, background: STEP_STATUS[s.status].bg, textDecoration: 'none' }}>{STEP_STATUS[s.status].label}</Link>
                        : <StatusSelect stepId={s.id} status={s.status} label={`Status of ${s.title}`} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          {steps.length === 0 && <section className="mo-panel"><p className="mo-empty">You have no open steps. Nice.</p></section>}
        </div>

        <aside className="mo-side">
          <section className="mo-panel" aria-label="Needs your action">
            <div className="mo-section-title" style={{ color: actions.length ? '#B91C1C' : undefined }}>
              <span>Needs your action</span><span className="mo-count">{actions.length}</span>
            </div>
            {actions.length === 0 ? <p className="mo-empty">Nothing waiting on you.</p> : (
              <ul className="mo-list">
                {actions.map(i => (
                  <li key={i.id} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                    <div>
                      <Link href={link(i)} style={{ fontWeight: 600 }}>{i.title}</Link>
                      {i.body && <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{i.body}</div>}
                      <div className="mo-muted" style={{ fontSize: 13 }}>From {nameOf(i.actor_id)} · {ago(i.created_at)}</div>
                    </div>
                    <ClearButton id={i.id} label="Done" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mo-panel" aria-label="FYI">
            <div className="mo-section-title">
              <span>FYI</span>
              {fyis.length > 0 ? <ClearAllFyiButton /> : <span className="mo-count">0</span>}
            </div>
            {fyis.length === 0 ? <p className="mo-empty">You&apos;re caught up.</p> : (
              <ul className="mo-list">
                {fyis.map(i => (
                  <li key={i.id} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                    <div>
                      <Link href={link(i)} style={{ fontWeight: 600 }}>{i.title}</Link>
                      {i.body && <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{i.body}</div>}
                      <div className="mo-muted" style={{ fontSize: 13 }}>{nameOf(i.actor_id)} · {ago(i.created_at)}</div>
                    </div>
                    <ClearButton id={i.id} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
