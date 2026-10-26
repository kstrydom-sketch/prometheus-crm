'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addStep, clearAllFyi, clearInboxItem, createMoment, deleteStep, rescheduleMoment, setFollowing, updateMoment,
} from '@/lib/moments/actions'
import type { MomentStatus } from '@/lib/moments/model'
import type { Person } from './StepControls'
import './moments.css'

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

export function FollowButton({ momentId, following }: { momentId: string; following: boolean }) {
  const { pending, run } = useAction()
  return (
    <button type="button" className={following ? 'btn-secondary btn-sm' : 'btn-accent-outline btn-sm'} disabled={pending}
      onClick={() => run(() => setFollowing(momentId, !following))}>
      {following ? 'Following ✓' : 'Follow'}
    </button>
  )
}

export function MomentOwnerSelect({ momentId, ownerId, people }: { momentId: string; ownerId: string | null; people: Person[] }) {
  const { pending, error, run } = useAction()
  return (
    <>
      <select aria-label="Moment owner" className={`mo-inline${ownerId ? '' : ' is-empty'}`} value={ownerId ?? ''} disabled={pending}
        onChange={e => run(() => updateMoment(momentId, { owner_id: e.target.value || null }))}>
        <option value="">No owner</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {error && <span className="mo-error">{error}</span>}
    </>
  )
}

export function MomentStatusSelect({ momentId, status }: { momentId: string; status: MomentStatus }) {
  const { pending, run } = useAction()
  return (
    <select aria-label="Moment status" className="mo-inline" value={status} disabled={pending}
      onChange={e => run(() => updateMoment(momentId, { status: e.target.value as MomentStatus }))}>
      <option value="active">Active</option>
      <option value="on_hold">On hold</option>
      <option value="launched">Launched</option>
      <option value="cancelled">Cancelled</option>
    </select>
  )
}

export function RescheduleForm({ momentId, startDate }: { momentId: string; startDate: string }) {
  const { pending, error, run } = useAction()
  const [value, setValue] = useState(startDate)
  return (
    <div className="mo-row">
      <input type="date" aria-label="Cycle start date" value={value} onChange={e => setValue(e.target.value)} style={{ width: 'auto' }} />
      <button type="button" className="btn-secondary btn-sm" disabled={pending || value === startDate}
        onClick={() => run(() => rescheduleMoment(momentId, value))}>
        {pending ? 'Re-planning…' : 'Re-plan open steps'}
      </button>
      {error && <span className="mo-error">{error}</span>}
    </div>
  )
}

export function AddStepForm({ momentId, groups }: { momentId: string; groups: Array<{ id: string; title: string }> }) {
  const { pending, error, run } = useAction()
  const [title, setTitle] = useState('')
  const [parent, setParent] = useState('')
  const [due, setDue] = useState('')
  return (
    <form className="mo-row" onSubmit={e => { e.preventDefault(); run(() => addStep(momentId, parent || null, title, due || null), () => { setTitle(''); setDue('') }) }}>
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

export function DeleteStepButton({ stepId, momentId }: { stepId: string; momentId: string }) {
  const { pending, error, run } = useAction()
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  if (!confirm) return <button type="button" className="btn-danger btn-sm" onClick={() => setConfirm(true)}>Remove step</button>
  return (
    <div className="mo-row">
      <span style={{ fontSize: 14 }}>Remove this step and its comments?</span>
      <button type="button" className="btn-danger btn-sm" disabled={pending}
        onClick={() => run(() => deleteStep(stepId), () => router.push(`/moments/${momentId}`))}>Yes, remove</button>
      <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirm(false)}>Keep it</button>
      {error && <span className="mo-error">{error}</span>}
    </div>
  )
}

export function NewMomentForm({ brands, people, defaultOwner }: { brands: Array<{ id: string; name: string }>; people: Person[]; defaultOwner: string | null }) {
  const { pending, error, run } = useAction()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const nextMonth = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7) })()
  if (!open) return <button type="button" className="btn-primary" onClick={() => setOpen(true)}>+ New moment</button>
  return (
    <form className="mo-panel mo-panel-pad" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end', width: '100%' }}
      onSubmit={e => {
        e.preventDefault()
        const fd = new FormData(e.currentTarget)
        run(async () => {
          const res = await createMoment(fd)
          if (res.ok) router.push(`/moments/${res.id}`)
          return res
        })
      }}>
      <div><label htmlFor="nm-brand">Client</label>
        <select id="nm-brand" name="brand_id" required defaultValue="">
          <option value="" disabled>Choose a client</option>
          {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select></div>
      <div><label htmlFor="nm-month">Month it&apos;s for</label><input id="nm-month" type="month" name="target_month" defaultValue={nextMonth} required /></div>
      <div><label htmlFor="nm-slot">Moment</label>
        <select id="nm-slot" name="slot" defaultValue="1"><option value="1">M1</option><option value="2">M2</option><option value="3">M3</option><option value="4">M4</option></select></div>
      <div><label htmlFor="nm-start">Cycle starts (day 0)</label><input id="nm-start" type="date" name="start_date" defaultValue={new Date().toISOString().slice(0, 10)} required /></div>
      <div><label htmlFor="nm-owner">Owner</label>
        <select id="nm-owner" name="owner_id" defaultValue={defaultOwner ?? ''}>
          {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></div>
      <div className="mo-row">
        <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Creating…' : 'Create with steps'}</button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p className="mo-muted" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 14 }}>
        Every step gets a due date from the cycle: offer by day 1, client approval by day 4, built and reviewed by day 8, with the client by day 10, live on day 15 (working days).
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
