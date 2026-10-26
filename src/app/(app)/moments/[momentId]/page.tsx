import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedProfiles } from '@/lib/profiles'
import { profileName } from '@/lib/types'
import {
  describeActivity, formatDue, groupStatus, isOpen, isOverdue, MOMENT_STAGE, momentStage, orderSteps, STEP_STATUS, todayIso,
  type ActivityRow, type Moment, type MomentStep, type StepComment,
} from '@/lib/moments/model'
import { AssigneeSelect, DueInput, StatusSelect, type Person } from '@/components/moments/StepControls'
import StepComposer from '@/components/moments/StepComposer'
import {
  AddStepForm, DeleteStepButton, FollowButton, MomentOwnerSelect, MomentStatusSelect, RescheduleForm,
} from '@/components/moments/MomentControls'
import '@/components/moments/moments.css'

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

export default async function MomentPage({
  params, searchParams,
}: {
  params: Promise<{ momentId: string }>
  searchParams: Promise<{ step?: string }>
}) {
  const [{ momentId }, { step: selectedId }] = await Promise.all([params, searchParams])
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const supabase = await createClient()
  const profiles = await getCachedProfiles()
  const me = profiles.find(p => p.email === user.email?.toLowerCase())

  const [{ data: momentRaw }, { data: stepsRaw }, { data: commentsRaw }, { data: activityRaw }, { data: followersRaw }] = await Promise.all([
    supabase.from('moments').select('*, brands(id, name)').eq('id', momentId).maybeSingle(),
    supabase.from('moment_steps').select('*').eq('moment_id', momentId),
    supabase.from('step_comments').select('*').eq('moment_id', momentId).order('created_at', { ascending: true }),
    supabase.from('activity_log').select('*').eq('moment_id', momentId).order('created_at', { ascending: false }).limit(200),
    supabase.from('moment_followers').select('profile_id').eq('moment_id', momentId),
  ])
  if (!momentRaw) notFound()
  const moment = momentRaw as unknown as Moment & { brands: { id: string; name: string } | null }
  const steps = orderSteps((stepsRaw ?? []) as MomentStep[])
  const comments = (commentsRaw ?? []) as StepComment[]
  const activity = (activityRaw ?? []) as ActivityRow[]
  const followers = (followersRaw ?? []).map(f => f.profile_id)

  const people: Person[] = profiles.filter(p => p.can_edit).map(p => ({ id: p.id, name: profileName(p) }))
  const nameOf = (id: string | null) => (id ? people.find(p => p.id === id)?.name ?? 'Someone' : 'Unassigned')
  const stepTitle = (id: string | null) => steps.find(s => s.id === id)?.title ?? 'a removed step'
  const today = todayIso()
  const work = steps.filter(s => !s.is_group)
  const done = work.filter(s => !isOpen(s.status)).length
  const late = work.filter(s => isOverdue(s, today))
  const selected = steps.find(s => s.id === selectedId && !s.is_group) ?? null
  const stage = momentStage(work)
  const next = work.find(s => isOpen(s.status))
  const commentCount = (stepId: string) => comments.filter(c => c.step_id === stepId).length

  return (
    <div className="mo-page">
      <div>
        <Link href="/moments" className="mo-crumb">← Moments</Link>
      </div>

      <header className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="mo-spread">
          <div>
            <div className="mo-row" style={{ gap: 14 }}>
              <h1 className="mo-h1">{moment.name}</h1>
              <span className="mo-pill" style={{ fontSize: 15, padding: '5px 14px', color: MOMENT_STAGE[stage].fg, background: MOMENT_STAGE[stage].bg }}>{MOMENT_STAGE[stage].label}</span>
            </div>
            {next && (
              <p style={{ margin: '6px 0 0', fontSize: 14 }}>
                <span className="mo-muted">Next: </span>
                <Link href={`/moments/${moment.id}?step=${next.id}`} scroll={false} className="mo-step-title">{next.title}</Link>
                <span className="mo-muted"> · {nameOf(next.assignee_id)} · {formatDue(next.due_date)} · </span>
                <span style={{ color: STEP_STATUS[next.status].fg, fontWeight: 600 }}>{STEP_STATUS[next.status].label}</span>
              </p>
            )}
            <p className="mo-sub">
              {moment.brands && <Link href={`/brands/${moment.brands.id}`} className="mo-crumb">{moment.brands.name}</Link>}
              {' · '}Launch <b style={{ color: 'var(--text-primary)' }}>{formatDue(moment.launch_date)}</b>
              {' · '}{done} of {work.length} steps done
              {late.length > 0 && <span className="mo-pill mo-late" style={{ marginLeft: 10 }}>{late.length} late</span>}
            </p>
          </div>
          <FollowButton momentId={moment.id} following={!!me && followers.includes(me.id)} />
        </div>
        <div className="mo-row" style={{ gap: 24, fontSize: 14 }}>
          <span className="mo-row" style={{ gap: 4 }}><span className="mo-muted">Owner</span><MomentOwnerSelect momentId={moment.id} ownerId={moment.owner_id} people={people} /></span>
          <span className="mo-row" style={{ gap: 4 }}><span className="mo-muted">Status</span><MomentStatusSelect momentId={moment.id} status={moment.status} /></span>
          <span className="mo-row" style={{ gap: 8 }}><span className="mo-muted">Cycle start</span><RescheduleForm momentId={moment.id} startDate={moment.start_date} /></span>
          <span className="mo-muted">{followers.length} following</span>
          {moment.offer_card_id && <Link href={`/offers/${moment.offer_card_id}`} className="mo-crumb">Old offer card →</Link>}
          {moment.project_id && moment.brands && <Link href={`/brands/${moment.brands.id}/projects/${moment.project_id}`} className="mo-crumb">Old production card →</Link>}
        </div>
      </header>

      <div className="mo-layout">
        <section className="mo-panel" aria-label="Steps">
          <table className="mo-steps">
            <thead>
              <tr><th>Step</th><th>Owner</th><th>Due</th><th>Status</th></tr>
            </thead>
            <tbody>
              {steps.map(s => {
                if (s.is_group) {
                  const kids = steps.filter(c => c.parent_id === s.id)
                  const gs = groupStatus(kids)
                  const kidsDone = kids.filter(c => !isOpen(c.status)).length
                  return (
                    <tr key={s.id} className="mo-group">
                      <td colSpan={3}>{s.title} <span className="mo-count">· {kidsDone} of {kids.length} done</span></td>
                      <td><span className="mo-pill" style={{ color: STEP_STATUS[gs].fg, background: STEP_STATUS[gs].bg }}>{STEP_STATUS[gs].label}</span></td>
                    </tr>
                  )
                }
                const n = commentCount(s.id)
                return (
                  <tr key={s.id} className={`mo-step${s.id === selected?.id ? ' is-selected' : ''}`}>
                    <td>
                      {s.depth > 0 && <span className="mo-indent" />}
                      <Link href={`/moments/${moment.id}?step=${s.id}`} scroll={false} className={`mo-step-title${isOpen(s.status) ? '' : ' is-done'}`}>
                        {s.title}
                        {n > 0 && <span className="mo-count">💬 {n}</span>}
                      </Link>
                    </td>
                    <td><AssigneeSelect stepId={s.id} assigneeId={s.assignee_id} people={people} label={`Owner of ${s.title}`} /></td>
                    <td><DueInput key={s.due_date ?? 'none'} stepId={s.id} due={s.due_date} open={isOpen(s.status)} label={`Due date of ${s.title}`} /></td>
                    <td><StatusSelect stepId={s.id} status={s.status} label={`Status of ${s.title}`} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
            <AddStepForm momentId={moment.id} groups={steps.filter(s => s.is_group).map(s => ({ id: s.id, title: s.title }))} />
          </div>
        </section>

        <aside className="mo-side">
          {selected ? (
            <section className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-label="Selected step">
              <div className="mo-spread">
                <h2 className="mo-h2">{selected.title}</h2>
                <Link href={`/moments/${moment.id}`} scroll={false} className="mo-crumb" aria-label="Close step">Close ✕</Link>
              </div>
              <div className="mo-field">
                <span>Owner</span><div><AssigneeSelect stepId={selected.id} assigneeId={selected.assignee_id} people={people} /></div>
                <span>Due</span><div><DueInput key={selected.due_date ?? 'none'} stepId={selected.id} due={selected.due_date} open={isOpen(selected.status)} /></div>
                <span>Status</span><div><StatusSelect stepId={selected.id} status={selected.status} /></div>
                {selected.completed_at && <><span>Finished</span><div>{when(selected.completed_at)}</div></>}
              </div>
              <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0 }} />
              <div className="mo-thread">
                {comments.filter(c => c.step_id === selected.id).map(c => (
                  <article key={c.id} className="mo-comment">
                    <div className="mo-comment-head">
                      <b>{nameOf(c.author_id)}</b>
                      <span className={`mo-kind mo-kind-${c.kind}`}>{c.kind === 'needs_action' ? 'Needs action' : c.kind === 'fyi' ? 'FYI' : 'Note'}</span>
                      <span className="mo-muted" style={{ fontSize: 13 }}>{when(c.created_at)}</span>
                    </div>
                    <div className="mo-comment-body">{c.body}</div>
                    {c.mentions.length > 0 && <div className="mo-muted" style={{ fontSize: 13 }}>Tagged: {c.mentions.map(nameOf).join(', ')}</div>}
                  </article>
                ))}
                {commentCount(selected.id) === 0 && <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>No comments on this step yet.</p>}
              </div>
              <StepComposer momentId={moment.id} stepId={selected.id} people={people} defaultMention={selected.assignee_id} />
              <details>
                <summary className="mo-muted" style={{ cursor: 'pointer', fontSize: 14 }}>History of this step</summary>
                <ul className="mo-activity" style={{ marginTop: 8 }}>
                  {activity.filter(a => a.step_id === selected.id).map(a => (
                    <li key={a.id}><span>{describeActivity(a, nameOf, stepTitle)}</span><time dateTime={a.created_at}>{when(a.created_at)}</time></li>
                  ))}
                </ul>
              </details>
              <DeleteStepButton stepId={selected.id} momentId={moment.id} />
            </section>
          ) : (
            <section className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 className="mo-h2">Discussion</h2>
              <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>Click a step to see its comments. Comments here are about the whole moment.</p>
              <div className="mo-thread">
                {comments.filter(c => !c.step_id).map(c => (
                  <article key={c.id} className="mo-comment">
                    <div className="mo-comment-head"><b>{nameOf(c.author_id)}</b><span className={`mo-kind mo-kind-${c.kind}`}>{c.kind === 'needs_action' ? 'Needs action' : c.kind === 'fyi' ? 'FYI' : 'Note'}</span><span className="mo-muted" style={{ fontSize: 13 }}>{when(c.created_at)}</span></div>
                    <div className="mo-comment-body">{c.body}</div>
                  </article>
                ))}
              </div>
              <StepComposer momentId={moment.id} stepId={null} people={people} defaultMention={moment.owner_id} />
            </section>
          )}

          <section className="mo-panel mo-panel-pad" aria-label="Activity">
            <h2 className="mo-h2" style={{ marginBottom: 8 }}>Activity</h2>
            <ul className="mo-activity">
              {activity.slice(0, 40).map(a => (
                <li key={a.id}><span>{describeActivity(a, nameOf, stepTitle)}</span><time dateTime={a.created_at}>{when(a.created_at)}</time></li>
              ))}
              {activity.length === 0 && <li><span>No changes yet.</span></li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
