'use client'

import { useState, useTransition } from 'react'
import { runReviewAction, saveRoundNote } from '@/lib/jobs/review-actions'
import type { ActionSpec, Deliverable } from '@/lib/jobs/review'
import './jobs.css'

/** The next moves for one deliverable. Actions that send work back ask why. */
export function ReviewButtons({ jobId, deliverable, actions }: { jobId: string; deliverable: Deliverable; actions: ActionSpec[] }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<ActionSpec | null>(null)
  const [note, setNote] = useState('')

  const run = (spec: ActionSpec, text = '') => {
    setError(null)
    start(async () => {
      const res = await runReviewAction(jobId, deliverable, spec.action, text)
      if (!res.ok) setError(res.error)
      else { setAsking(null); setNote('') }
    })
  }

  if (!actions.length) return null
  if (asking) {
    return (
      <form className="rv-ask" onSubmit={e => { e.preventDefault(); run(asking, note) }}>
        <label htmlFor={`rv-note-${deliverable}`}>{asking.label}: what needs to change?</label>
        <textarea id={`rv-note-${deliverable}`} rows={3} value={note} onChange={e => setNote(e.target.value)} autoFocus required
          placeholder="Be specific. This is saved on the round and sent to whoever makes the revisions." />
        <div className="mo-row">
          <button type="submit" className="btn-danger btn-sm" disabled={pending || !note.trim()}>{pending ? 'Sending…' : asking.label}</button>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setAsking(null)}>Cancel</button>
        </div>
        {error && <span className="mo-error" role="alert">{error}</span>}
      </form>
    )
  }
  return (
    <div className="rv-actions">
      {actions.map(a => (
        <button key={a.action} type="button" disabled={pending}
          className={a.tone === 'primary' ? 'btn-primary btn-sm' : a.tone === 'danger' ? 'btn-danger btn-sm' : 'btn-secondary btn-sm'}
          onClick={() => (a.needsNote ? setAsking(a) : run(a))}>
          {a.label}
        </button>
      ))}
      {pending && <span className="mo-muted" style={{ fontSize: 13 }}>Working…</span>}
      {error && <span className="mo-error" role="alert" style={{ flexBasis: '100%' }}>{error}</span>}
    </div>
  )
}

/** A round's note, with a way to add or fix it afterwards. */
export function RoundNote({ roundId, jobId, note }: { roundId: string; jobId: string; note: string | null }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note ?? '')
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  if (!editing) {
    return (
      <div className="rv-note">
        {note ? <p>{note}</p> : null}
        <button type="button" className="mo-reply-btn" onClick={() => setEditing(true)}>{note ? 'Edit note' : 'Add note'}</button>
      </div>
    )
  }
  return (
    <form className="rv-ask" onSubmit={e => {
      e.preventDefault()
      start(async () => {
        const res = await saveRoundNote(roundId, jobId, text)
        if (res.ok) setEditing(false)
        else setError(res.error)
      })
    }}>
      <textarea rows={3} value={text} onChange={e => setText(e.target.value)} aria-label="Round note" autoFocus />
      <div className="mo-row">
        <button type="submit" className="btn-primary btn-sm" disabled={pending}>Save</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
      </div>
      {error && <span className="mo-error">{error}</span>}
    </form>
  )
}
