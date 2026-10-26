'use client'

import { useState, useTransition } from 'react'
import { updateStep } from '@/lib/moments/actions'
import { STEP_STATUS, STEP_STATUS_ORDER, todayIso, type StepStatus } from '@/lib/moments/model'
import './moments.css'

export type Person = { id: string; name: string }

function useSave(stepId: string) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const save = (patch: Parameters<typeof updateStep>[1]) => {
    setError(null)
    start(async () => {
      const res = await updateStep(stepId, patch)
      if (!res.ok) setError(res.error)
    })
  }
  return { pending, error, save }
}

export function StatusSelect({ stepId, status, label = 'Status' }: { stepId: string; status: StepStatus; label?: string }) {
  const { pending, error, save } = useSave(stepId)
  const s = STEP_STATUS[status]
  return (
    <>
      <select
        aria-label={label}
        className="mo-status"
        value={status}
        disabled={pending}
        onChange={e => save({ status: e.target.value as StepStatus })}
        style={{ color: s.fg, background: s.bg, opacity: pending ? 0.6 : 1 }}
      >
        {STEP_STATUS_ORDER.map(k => <option key={k} value={k}>{STEP_STATUS[k].label}</option>)}
      </select>
      {error && <span className="mo-error" role="alert"> {error}</span>}
    </>
  )
}

export function AssigneeSelect({ stepId, assigneeId, people, label = 'Owner' }: { stepId: string; assigneeId: string | null; people: Person[]; label?: string }) {
  const { pending, error, save } = useSave(stepId)
  return (
    <>
      <select
        aria-label={label}
        className={`mo-inline${assigneeId ? '' : ' is-empty'}`}
        value={assigneeId ?? ''}
        disabled={pending}
        onChange={e => save({ assignee_id: e.target.value || null })}
      >
        <option value="">Unassigned</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {error && <span className="mo-error" role="alert"> {error}</span>}
    </>
  )
}

export function DueInput({ stepId, due, open, label = 'Due date' }: { stepId: string; due: string | null; open: boolean; label?: string }) {
  const { pending, error, save } = useSave(stepId)
  const late = open && !!due && due < todayIso()
  return (
    <>
      <input
        type="date"
        aria-label={label}
        className={`mo-inline${due ? '' : ' is-empty'}${late ? ' is-late' : ''}`}
        defaultValue={due ?? ''}
        disabled={pending}
        onChange={e => save({ due_date: e.target.value || null })}
      />
      {error && <span className="mo-error" role="alert"> {error}</span>}
    </>
  )
}
