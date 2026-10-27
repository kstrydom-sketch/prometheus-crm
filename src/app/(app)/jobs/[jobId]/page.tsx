import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedProfiles } from '@/lib/profiles'
import { profileName } from '@/lib/types'
import {
  describeActivity, formatDue, groupStatus, isOpen, isOverdue, jobStage, orderSteps, stageInfo, STEP_STATUS, todayIso,
  type ActivityRow, type Job, type JobStep, type StepComment,
} from '@/lib/jobs/model'
import { AssigneeSelect, DueInput, StatusSelect, type Person } from '@/components/jobs/StepControls'
import StepComposer from '@/components/jobs/StepComposer'
import CommentThreads from '@/components/jobs/CommentThreads'
import {
  AddStepForm, DeleteStepButton, FollowButton, JobOwnerSelect, JobStatusSelect, RescheduleForm,
} from '@/components/jobs/JobControls'
import { ReviewSummary } from '@/components/jobs/ReviewRounds'
import StepWork from '@/components/jobs/StepWork'
import { loadCardWork } from '@/lib/jobs/card-work'
import { isLinkedStep, stepDeliverable, type Deliverable } from '@/lib/jobs/review'
import '@/components/jobs/jobs.css'

/** A linked step's status: shown, not chosen. It moves with the review. */
function LinkedStatus({ s }: { s: Pick<JobStep, 'status'> }) {
  return <span className="mo-pill is-linked" title="Moves with the review" style={{ color: STEP_STATUS[s.status].fg, background: STEP_STATUS[s.status].bg }}>{STEP_STATUS[s.status].label}</span>
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

export default async function JobPage({
  params, searchParams,
}: {
  params: Promise<{ jobId: string }>
  searchParams: Promise<{ step?: string }>
}) {
  const [{ jobId }, { step: selectedId }] = await Promise.all([params, searchParams])
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const supabase = await createClient()
  const profiles = await getCachedProfiles()
  const me = profiles.find(p => p.email === user.email?.toLowerCase())

  const [{ data: jobRaw }, { data: stepsRaw }, { data: commentsRaw }, { data: activityRaw }, { data: followersRaw }] = await Promise.all([
    supabase.from('jobs').select('*, brands(id, name), workflow_templates(name)').eq('id', jobId).maybeSingle(),
    supabase.from('job_steps').select('*').eq('job_id', jobId),
    supabase.from('step_comments').select('*').eq('job_id', jobId).order('created_at', { ascending: true }),
    supabase.from('activity_log').select('*').eq('job_id', jobId).order('created_at', { ascending: false }).limit(200),
    supabase.from('job_followers').select('profile_id').eq('job_id', jobId),
  ])
  if (!jobRaw) notFound()
  const job = jobRaw as unknown as Job & { brands: { id: string; name: string } | null; workflow_templates: { name: string } | null }
  const isTask = job.kind === 'task'
  const steps = orderSteps((stepsRaw ?? []) as JobStep[])
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
  // A task is its one step, so its step panel is always open.
  const selected = steps.find(s => s.id === selectedId && !s.is_group) ?? (isTask ? work[0] ?? null : null)
  const stageKey = jobStage(job.stages, work)
  const stage = stageKey ? stageInfo(job.stages, stageKey, job.done_label) : null
  const describe = (a: ActivityRow) => describeActivity(a, nameOf, stepTitle, job)
  const next = work.find(s => isOpen(s.status))
  const commentCount = (stepId: string) => comments.filter(c => c.step_id === stepId).length
  // The offer and production cards behind the linked steps, and their rounds.
  const cardWork = await loadCardWork(supabase, job)
  const linked = (s: JobStep) => isLinkedStep(s, job)
  const stepFor = (d: Deliverable) => {
    const mine = work.filter(s => stepDeliverable(s.key) === d)
    return (mine.find(s => isOpen(s.status)) ?? mine[mine.length - 1])?.id ?? null
  }

  return (
    <div className="mo-page">
      <div>
        <Link href="/jobs" className="mo-crumb">← Jobs</Link>
      </div>

      <header className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="mo-spread">
          <div>
            <div className="mo-row" style={{ gap: 14 }}>
              <h1 className="mo-h1">{job.name}</h1>
              {stage && <span className="mo-pill" style={{ fontSize: 15, padding: '5px 14px', color: stage.fg, background: stage.bg }}>{stage.label}</span>}
            </div>
            {next && !isTask && (
              <p style={{ margin: '6px 0 0', fontSize: 14 }}>
                <span className="mo-muted">Next: </span>
                <Link href={`/jobs/${job.id}?step=${next.id}`} scroll={false} className="mo-step-title">{next.title}</Link>
                <span className="mo-muted"> · {nameOf(next.assignee_id)} · {formatDue(next.due_date)} · </span>
                <span style={{ color: STEP_STATUS[next.status].fg, fontWeight: 600 }}>{STEP_STATUS[next.status].label}</span>
              </p>
            )}
            <p className="mo-sub">
              {isTask ? 'One-off task' : job.workflow_templates?.name ?? 'Workflow'}
              {' · '}{job.brands ? <Link href={`/brands/${job.brands.id}`} className="mo-crumb">{job.brands.name}</Link> : 'Internal'}
              {!isTask && <>{' · '}{job.due_label} <b style={{ color: 'var(--text-primary)' }}>{formatDue(job.due_date)}</b></>}
              {!isTask && <>{' · '}{done} of {work.length} steps done</>}
              {late.length > 0 && <span className="mo-pill mo-late" style={{ marginLeft: 10 }}>{late.length} late</span>}
            </p>
          </div>
          <FollowButton jobId={job.id} following={!!me && followers.includes(me.id)} />
        </div>
        <div className="mo-row" style={{ gap: 24, fontSize: 14 }}>
          <span className="mo-row" style={{ gap: 4 }}><span className="mo-muted">Owner</span><JobOwnerSelect jobId={job.id} ownerId={job.owner_id} people={people} /></span>
          <span className="mo-row" style={{ gap: 4 }}><span className="mo-muted">Status</span><JobStatusSelect jobId={job.id} status={job.status} doneLabel={job.done_label} /></span>
          {work.some(s => s.day_offset !== null) && (
            <span className="mo-row" style={{ gap: 8 }}><span className="mo-muted">Start (day 0)</span><RescheduleForm jobId={job.id} startDate={job.start_date} /></span>
          )}
          <span className="mo-muted">{followers.length} following</span>
          {job.offer_card_id && <Link href={`/offers/${job.offer_card_id}`} className="mo-crumb">Offer card →</Link>}
          {job.project_id && job.brands && <Link href={`/brands/${job.brands.id}/projects/${job.project_id}`} className="mo-crumb">Production card →</Link>}
        </div>
      </header>

      <ReviewSummary jobId={job.id} states={cardWork.states} rounds={cardWork.rounds} stepFor={stepFor} />

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
                      <Link href={`/jobs/${job.id}?step=${s.id}`} scroll={false} className={`mo-step-title${isOpen(s.status) ? '' : ' is-done'}`}>
                        {s.title}
                        {n > 0 && <span className="mo-count">💬 {n}</span>}
                      </Link>
                    </td>
                    <td><AssigneeSelect stepId={s.id} assigneeId={s.assignee_id} people={people} label={`Owner of ${s.title}`} /></td>
                    <td><DueInput key={s.due_date ?? 'none'} stepId={s.id} due={s.due_date} open={isOpen(s.status)} label={`Due date of ${s.title}`} /></td>
                    <td>{linked(s) ? <LinkedStatus s={s} /> : <StatusSelect stepId={s.id} status={s.status} label={`Status of ${s.title}`} />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!isTask && <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
            <AddStepForm jobId={job.id} groups={steps.filter(s => s.is_group).map(s => ({ id: s.id, title: s.title }))} />
          </div>}
        </section>

        <aside className="mo-side">
          {selected ? (
            <section className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 16 }} aria-label="Selected step">
              <div className="mo-spread">
                <h2 className="mo-h2">{selected.title}</h2>
                {!isTask && <Link href={`/jobs/${job.id}`} scroll={false} className="mo-crumb" aria-label="Close step">Close ✕</Link>}
              </div>
              <div className="mo-field">
                <span>Owner</span><div><AssigneeSelect stepId={selected.id} assigneeId={selected.assignee_id} people={people} /></div>
                <span>Due</span><div><DueInput key={selected.due_date ?? 'none'} stepId={selected.id} due={selected.due_date} open={isOpen(selected.status)} /></div>
                <span>Status</span><div>{linked(selected) ? <LinkedStatus s={selected} /> : <StatusSelect stepId={selected.id} status={selected.status} />}</div>
                {selected.completed_at && <><span>Finished</span><div>{when(selected.completed_at)}</div></>}
              </div>
              {linked(selected) && (
                <>
                  <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0 }} />
                  <StepWork jobId={job.id} brandId={job.brands?.id ?? null} stepKey={selected.key} work={cardWork} />
                </>
              )}
              <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0 }} />
              <CommentThreads comments={comments.filter(c => c.step_id === selected.id)} people={people} jobId={job.id} stepId={selected.id} emptyText="No comments on this step yet." />
              <StepComposer jobId={job.id} stepId={selected.id} people={people} defaultMention={selected.assignee_id} />
              <details>
                <summary className="mo-muted" style={{ cursor: 'pointer', fontSize: 14 }}>History of this step</summary>
                <ul className="mo-activity" style={{ marginTop: 8 }}>
                  {activity.filter(a => a.step_id === selected.id).map(a => (
                    <li key={a.id}><span>{describe(a)}</span><time dateTime={a.created_at}>{when(a.created_at)}</time></li>
                  ))}
                </ul>
              </details>
              {!isTask && <DeleteStepButton stepId={selected.id} jobId={job.id} />}
            </section>
          ) : (
            <section className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 className="mo-h2">Discussion</h2>
              <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>Click a step to see its comments. Comments here are about the whole job.</p>
              <CommentThreads comments={comments.filter(c => !c.step_id)} people={people} jobId={job.id} stepId={null} emptyText="No discussion yet." />
              <StepComposer jobId={job.id} stepId={null} people={people} defaultMention={job.owner_id} />
            </section>
          )}

          <section className="mo-panel mo-panel-pad" aria-label="Activity">
            <h2 className="mo-h2" style={{ marginBottom: 8 }}>Activity</h2>
            <ul className="mo-activity">
              {activity.slice(0, 40).map(a => (
                <li key={a.id}><span>{describe(a)}</span><time dateTime={a.created_at}>{when(a.created_at)}</time></li>
              ))}
              {activity.length === 0 && <li><span>No changes yet.</span></li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}
