'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addStep, clearAllFyi, clearInboxItem, createJob, createTask, deleteStep, rescheduleJob, setFollowing, updateJob,
} from '@/lib/jobs/actions'
import { JOB_STATUS_ORDER, jobStatusLabel, templateLength, type JobStatus, type WorkflowTemplate } from '@/lib/jobs/model'
import type { Person } from './StepControls'
import './jobs.css'

function useAction() {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null)
    start(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? 'Something went wrong.')
      else after?.()
    })
  }
  return { pending, error, run }
}

export function FollowButton({ jobId, following }: { jobId: string; following: boolean }) {
  const { pending, run } = useAction()
  return (
    <button type="button" className={following ? 'btn-secondary btn-sm' : 'btn-accent-outline btn-sm'} disabled={pending}
      onClick={() => run(() => setFollowing(jobId, !following))}>
      {following ? 'Following ✓' : 'Follow'}
    </button>
  )
}

export function JobOwnerSelect({ jobId, ownerId, people }: { jobId: string; ownerId: string | null; people: Person[] }) {
  const { pending, error, run } = useAction()
  return (
    <>
      <select aria-label="Job owner" className={`mo-inline${ownerId ? '' : ' is-empty'}`} value={ownerId ?? ''} disabled={pending}
        onChange={e => run(() => updateJob(jobId, { owner_id: e.target.value || null }))}>
        <option value="">No owner</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {error && <span className="mo-error">{error}</span>}
    </>
  )
}

export function JobStatusSelect({ jobId, status, doneLabel }: { jobId: string; status: JobStatus; doneLabel: string }) {
  const { pending, run } = useAction()
  return (
    <select aria-label="Job status" className="mo-inline" value={status} disabled={pending}
      onChange={e => run(() => updateJob(jobId, { status: e.target.value as JobStatus }))}>
      {JOB_STATUS_ORDER.map(k => <option key={k} value={k}>{jobStatusLabel(k, doneLabel)}</option>)}
    </select>
  )
}

export function RescheduleForm({ jobId, startDate }: { jobId: string; startDate: string }) {
  const { pending, error, run } = useAction()
  const [value, setValue] = useState(startDate)
  return (
    <div className="mo-row">
      <input type="date" aria-label="Start date" value={value} onChange={e => setValue(e.target.value)} style={{ width: 'auto' }} />
      <button type="button" className="btn-secondary btn-sm" disabled={pending || value === startDate}
        onClick={() => run(() => rescheduleJob(jobId, value))}>
        {pending ? 'Re-planning…' : 'Re-plan open steps'}
      </button>
      {error && <span className="mo-error">{error}</span>}
    </div>
  )
}

export function AddStepForm({ jobId, groups }: { jobId: string; groups: Array<{ id: string; title: string }> }) {
  const { pending, error, run } = useAction()
  const [title, setTitle] = useState('')
  const [parent, setParent] = useState('')
  const [due, setDue] = useState('')
  return (
    <form className="mo-row" onSubmit={e => { e.preventDefault(); run(() => addStep(jobId, parent || null, title, due || null), () => { setTitle(''); setDue('') }) }}>
      <input aria-label="New step name" placeholder="Add a step…" value={title} onChange={e => setTitle(e.target.value)} style={{ flex: '1 1 220px', width: 'auto' }} />
      <select aria-label="Put the step under" value={parent} onChange={e => setParent(e.target.value)} style={{ width: 'auto' }}>
        <option value="">Top level</option>
        {groups.map(g => <option key={g.id} value={g.id}>Under {g.title}</option>)}
      </select>
      <input type="date" aria-label="New step due date" value={due} onChange={e => setDue(e.target.value)} style={{ width: 'auto' }} />
      <button type="submit" className="btn-secondary btn-sm" disabled={pending || !title.trim()}>Add step</button>
      {error && <span className="mo-error">{error}</span>}
    </form>
  )
}

export function DeleteStepButton({ stepId, jobId }: { stepId: string; jobId: string }) {
  const { pending, error, run } = useAction()
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  if (!confirm) return <button type="button" className="btn-danger btn-sm" onClick={() => setConfirm(true)}>Remove step</button>
  return (
    <div className="mo-row">
      <span style={{ fontSize: 14 }}>Remove this step and its comments?</span>
      <button type="button" className="btn-danger btn-sm" disabled={pending}
        onClick={() => run(() => deleteStep(stepId), () => router.push(`/jobs/${jobId}`))}>Yes, remove</button>
      <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirm(false)}>Keep it</button>
      {error && <span className="mo-error">{error}</span>}
    </div>
  )
}

type Brand = { id: string; name: string; billingDay?: number | null }
type TemplateOption = Pick<WorkflowTemplate, 'id' | 'name' | 'description' | 'uses_month_slot' | 'due_label' | 'steps' | 'stages'>

function ClientSelect({ id, brands, onPick }: { id: string; brands: Brand[]; onPick?: (b: Brand | null) => void }) {
  return (
    <select id={id} name="brand_id" required defaultValue="" onChange={e => onPick?.(brands.find(b => b.id === e.target.value) ?? null)}>
      <option value="" disabled>Choose a client</option>
      <option value="internal">Internal (no client)</option>
      {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  )
}

/** "+ New job" and "+ New task", side by side; each opens its own form. */
export function NewWorkButtons(props: { brands: Brand[]; people: Person[]; defaultOwner: string | null; templates: TemplateOption[]; defaultTemplate: string | null }) {
  const [open, setOpen] = useState<'job' | 'task' | null>(null)
  if (open === 'job') return <NewJobForm {...props} onCancel={() => setOpen(null)} />
  if (open === 'task') return <NewTaskForm {...props} onCancel={() => setOpen(null)} />
  return (
    <div className="mo-row">
      <button type="button" className="btn-secondary" onClick={() => setOpen('task')}>+ New task</button>
      <button type="button" className="btn-primary" onClick={() => setOpen('job')}>+ New job</button>
    </div>
  )
}

const formStyle = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end', width: '100%' } as const

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`

/** The next date (today or later) falling on the client's billing day, clamped to short months. */
function nextBillingDate(day: number): string {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  for (let add = 0; add < 3; add++) {
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + add
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    const d = new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10)
    if (d >= today) return d
  }
  return today
}

function NewJobForm({ brands, people, defaultOwner, templates, defaultTemplate, onCancel }: {
  brands: Brand[]; people: Person[]; defaultOwner: string | null; templates: TemplateOption[]; defaultTemplate: string | null; onCancel: () => void
}) {
  const { pending, error, run } = useAction()
  const router = useRouter()
  const [templateId, setTemplateId] = useState(defaultTemplate ?? templates[0]?.id ?? '')
  const template = templates.find(t => t.id === templateId)
  const nextMonth = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7) })()
  const days = template ? templateLength(template.steps) : 0
  const [brand, setBrand] = useState<Brand | null>(null)
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10))
  return (
    <form className="mo-panel mo-panel-pad" style={formStyle}
      onSubmit={e => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        run(async () => {
          const res = await createJob(fd)
          if (res.ok) router.push(`/jobs/${res.id}`)
          return res
        })
      }}>
      <div><label htmlFor="nj-template">Workflow</label>
        <select id="nj-template" name="template_id" value={templateId} onChange={e => setTemplateId(e.target.value)} required>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></div>
      <div><label htmlFor="nj-brand">Client</label><ClientSelect id="nj-brand" brands={brands} onPick={b => {
        setBrand(b)
        if (b?.billingDay) setStart(nextBillingDate(b.billingDay))
      }} /></div>
      {template?.uses_month_slot ? (
        <>
          <div><label htmlFor="nj-month">Month it&apos;s for</label><input id="nj-month" type="month" name="target_month" defaultValue={nextMonth} required /></div>
          <div><label htmlFor="nj-slot">Moment</label>
            <select id="nj-slot" name="slot" defaultValue="1"><option value="1">M1</option><option value="2">M2</option><option value="3">M3</option><option value="4">M4</option></select></div>
        </>
      ) : (
        <div><label htmlFor="nj-name">Name <span className="mo-muted">(optional)</span></label>
          <input id="nj-name" name="name" placeholder={template ? `Client · ${template.name}` : ''} /></div>
      )}
      <div><label htmlFor="nj-start">Starts (day 0)</label><input id="nj-start" type="date" name="start_date" value={start} onChange={e => setStart(e.target.value)} required />
        {brand && <small className="mo-muted" style={{ display: 'block', marginTop: 4 }}>{brand.billingDay ? `Bills on the ${ordinal(brand.billingDay)}, so it starts then` : 'No billing day on file'}</small>}</div>
      <div><label htmlFor="nj-owner">Owner</label>
        <select id="nj-owner" name="owner_id" defaultValue={defaultOwner ?? ''}>
          {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
      <div className="mo-row">
        <button type="submit" className="btn-primary" disabled={pending || !template}>{pending ? 'Creating…' : 'Create with steps'}</button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
      {template && (
        <p className="mo-muted" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 14 }}>
          {template.description ? `${template.description} ` : ''}
          {template.steps.length} steps{template.stages.length ? ` in ${template.stages.length} stages` : ''}, each with a due date counted from day 0.
          {' '}{template.due_label} on day {days} (working days).
        </p>
      )}
      {error && <span className="mo-error" style={{ gridColumn: '1 / -1' }}>{error}</span>}
    </form>
  )
}

function NewTaskForm({ brands, people, defaultOwner, onCancel }: { brands: Brand[]; people: Person[]; defaultOwner: string | null; onCancel: () => void }) {
  const { pending, error, run } = useAction()
  const router = useRouter()
  return (
    <form className="mo-panel mo-panel-pad" style={formStyle}
      onSubmit={e => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        run(async () => {
          const res = await createTask(fd)
          if (res.ok) router.push(`/jobs/${res.id}`)
          return res
        })
      }}>
      <div style={{ gridColumn: 'span 2' }}><label htmlFor="nt-title">Task</label>
        <input id="nt-title" name="title" required placeholder="e.g. Update the pricing sheet" autoFocus /></div>
      <div><label htmlFor="nt-brand">Client</label><ClientSelect id="nt-brand" brands={brands} /></div>
      <div><label htmlFor="nt-owner">Owner</label>
        <select id="nt-owner" name="owner_id" defaultValue={defaultOwner ?? ''}>
          {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
      <div><label htmlFor="nt-due">Due</label><input id="nt-due" type="date" name="due_date" /></div>
      <div className="mo-row">
        <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Creating…' : 'Create task'}</button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
      <p className="mo-muted" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 14 }}>
        For one-off work with no workflow. It lands in the owner&apos;s My work, with comments and history like any job.
      </p>
      {error && <span className="mo-error" style={{ gridColumn: '1 / -1' }}>{error}</span>}
    </form>
  )
}

export function ClearButton({ id, label = 'Clear' }: { id: string; label?: string }) {
  const { pending, run } = useAction()
  return <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => clearInboxItem(id))}>{pending ? '…' : label}</button>
}

export function ClearAllFyiButton() {
  const { pending, run } = useAction()
  return <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => clearAllFyi())}>{pending ? 'Clearing…' : 'Clear all FYIs'}</button>
}
