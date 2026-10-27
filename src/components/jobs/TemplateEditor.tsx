'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveTemplate, setTemplateArchived, type TemplateInput } from '@/lib/jobs/templates'
import { DONE_STAGE, newKey, stageInfo, templateLength, type TemplateStage, type TemplateStep } from '@/lib/jobs/model'
import './jobs.css'

// Edits one workflow template as a whole and saves it in one go. Order of the
// steps here is the order a new job lists them in; a group sits where its
// first step is.
export default function TemplateEditor({ id, initial, readOnly, archived, runningJobs }: {
  id: string | null
  initial: TemplateInput
  readOnly: boolean
  archived: boolean
  runningJobs: number
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [t, setT] = useState<TemplateInput>(initial)
  const [newStage, setNewStage] = useState('')

  const set = (patch: Partial<TemplateInput>) => { setT(prev => ({ ...prev, ...patch })); setSaved(false) }
  const setStep = (i: number, patch: Partial<TemplateStep>) => set({ steps: t.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const setStage = (i: number, patch: Partial<TemplateStage>) => set({ stages: t.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const move = <T,>(list: T[], i: number, by: number): T[] => {
    const j = i + by
    if (j < 0 || j >= list.length) return list
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  }
  const groups = [...new Set(t.steps.map(s => s.group).filter((g): g is string => !!g))]
  const used = (key: string) => t.steps.filter(s => s.stage === key).length

  const addStage = () => {
    const label = newStage.trim()
    if (!label) return
    set({ stages: [...t.stages, { key: newKey(label, t.stages.map(s => s.key)), label }] })
    setNewStage('')
  }
  const removeStage = (i: number) => {
    const key = t.stages[i].key
    set({ stages: t.stages.filter((_, j) => j !== i), steps: t.steps.map(s => (s.stage === key ? { ...s, stage: null } : s)) })
  }
  const addStep = () => {
    const last = t.steps[t.steps.length - 1]
    set({ steps: [...t.steps, { key: newKey(`step ${t.steps.length + 1}`, t.steps.map(s => s.key)), title: '', day: last?.day ?? 0, group: null, stage: last?.stage ?? t.stages[0]?.key ?? null }] })
  }

  const save = () => {
    setError(null)
    start(async () => {
      const res = await saveTemplate(id, t)
      if (!res.ok) { setError(res.error); return }
      setSaved(true)
      if (!id) router.push(`/jobs/templates/${res.id}`)
      else router.refresh()
    })
  }
  const toggleArchive = () => {
    if (!id) return
    setError(null)
    start(async () => {
      const res = await setTemplateArchived(id, !archived)
      if (!res.ok) setError(res.error)
      else router.refresh()
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <fieldset disabled={readOnly || pending} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
        <section className="mo-panel mo-panel-pad" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', alignItems: 'end' }}>
          <div><label htmlFor="tp-name">Name</label><input id="tp-name" value={t.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Client onboarding" /></div>
          <div style={{ gridColumn: 'span 2' }}><label htmlFor="tp-desc">What it&apos;s for</label>
            <input id="tp-desc" value={t.description} onChange={e => set({ description: e.target.value })} placeholder="One line, shown when someone creates a job" /></div>
          <div><label htmlFor="tp-due">End date is called</label><input id="tp-due" value={t.due_label} onChange={e => set({ due_label: e.target.value })} placeholder="Due" /></div>
          <div><label htmlFor="tp-done">Finished jobs are called</label><input id="tp-done" value={t.done_label} onChange={e => set({ done_label: e.target.value })} placeholder="Done" /></div>
          <label className="mo-row" style={{ gap: 8, fontWeight: 500, marginBottom: 10 }}>
            <input type="checkbox" checked={t.uses_month_slot} onChange={e => set({ uses_month_slot: e.target.checked })} style={{ width: 'auto' }} />
            Moment-type: ask for a month and M1/M2 slot
          </label>
        </section>

        <section className="mo-panel mo-panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-label="Stages">
          <div>
            <h2 className="mo-h2">Stages</h2>
            <p className="mo-muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
              In order. A job shows the earliest stage that still has open steps, and the Jobs list filters by them. Leave empty for no stages.
            </p>
          </div>
          <ol className="tp-stages">
            {t.stages.map((s, i) => {
              const info = stageInfo(t.stages, s.key, t.done_label)
              return (
                <li key={s.key}>
                  <span className="tp-swatch" style={{ background: info.bg, borderColor: info.fg }} />
                  <input aria-label={`Stage ${i + 1} name`} value={s.label} onChange={e => setStage(i, { label: e.target.value })} />
                  <span className="mo-muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{used(s.key)} step{used(s.key) === 1 ? '' : 's'}</span>
                  {!readOnly && <>
                    <button type="button" className="tp-icon" aria-label={`Move ${s.label} up`} onClick={() => set({ stages: move(t.stages, i, -1) })} disabled={i === 0}>↑</button>
                    <button type="button" className="tp-icon" aria-label={`Move ${s.label} down`} onClick={() => set({ stages: move(t.stages, i, 1) })} disabled={i === t.stages.length - 1}>↓</button>
                    <button type="button" className="tp-icon" aria-label={`Remove stage ${s.label}`} onClick={() => removeStage(i)}>✕</button>
                  </>}
                </li>
              )
            })}
            <li className="tp-done-stage">
              <span className="tp-swatch" style={{ background: stageInfo([], DONE_STAGE, '').bg }} />
              <span>{t.done_label || 'Done'}</span>
              <span className="mo-muted" style={{ fontSize: 13 }}>when every step is closed</span>
            </li>
          </ol>
          {!readOnly && (
            <form className="mo-row" onSubmit={e => { e.preventDefault(); addStage() }}>
              <input aria-label="New stage name" placeholder="Add a stage…" value={newStage} onChange={e => setNewStage(e.target.value)} style={{ flex: '0 1 280px', width: 'auto' }} />
              <button type="submit" className="btn-secondary btn-sm" disabled={!newStage.trim()}>Add stage</button>
            </form>
          )}
        </section>

        <section className="mo-panel" aria-label="Steps">
          <div className="mo-panel-pad" style={{ paddingBottom: 8 }}>
            <h2 className="mo-h2">Steps</h2>
            <p className="mo-muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
              Day is working days from the job&apos;s start (day 0); it sets each step&apos;s due date. Steps with the same group show together under it.
              {t.steps.length > 0 && <> The job&apos;s {(t.due_label || 'due').toLowerCase()} date is day {templateLength(t.steps)}.</>}
            </p>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="mo-steps tp-steps">
              <thead><tr><th>Step</th><th style={{ width: 90 }}>Day</th><th>Group</th><th>Stage</th>{!readOnly && <th aria-label="Reorder or remove" />}</tr></thead>
              <tbody>
                {t.steps.map((s, i) => (
                  <tr key={s.key}>
                    <td><input aria-label={`Step ${i + 1} name`} value={s.title} onChange={e => setStep(i, { title: e.target.value })} placeholder="What gets done" /></td>
                    <td><input aria-label={`Day of ${s.title || `step ${i + 1}`}`} type="number" min={0} max={365} value={Number.isFinite(s.day) ? s.day : ''}
                      onChange={e => setStep(i, { day: e.target.value === '' ? NaN : Number(e.target.value) })} /></td>
                    <td><input aria-label={`Group of ${s.title || `step ${i + 1}`}`} list="tp-groups" value={s.group ?? ''} onChange={e => setStep(i, { group: e.target.value || null })} placeholder="None" /></td>
                    <td>
                      <select aria-label={`Stage of ${s.title || `step ${i + 1}`}`} value={s.stage ?? ''} onChange={e => setStep(i, { stage: e.target.value || null })}>
                        {(!s.stage || !t.stages.length) && <option value="">{t.stages.length ? 'Pick a stage' : 'No stages'}</option>}
                        {t.stages.map(st => <option key={st.key} value={st.key}>{st.label}</option>)}
                      </select>
                    </td>
                    {!readOnly && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="tp-icon" aria-label={`Move ${s.title || 'step'} up`} onClick={() => set({ steps: move(t.steps, i, -1) })} disabled={i === 0}>↑</button>
                        <button type="button" className="tp-icon" aria-label={`Move ${s.title || 'step'} down`} onClick={() => set({ steps: move(t.steps, i, 1) })} disabled={i === t.steps.length - 1}>↓</button>
                        <button type="button" className="tp-icon" aria-label={`Remove ${s.title || 'step'}`} onClick={() => set({ steps: t.steps.filter((_, j) => j !== i) })}>✕</button>
                      </td>
                    )}
                  </tr>
                ))}
                {t.steps.length === 0 && <tr><td colSpan={5} className="mo-muted">No steps yet.</td></tr>}
              </tbody>
            </table>
            <datalist id="tp-groups">{groups.map(g => <option key={g} value={g} />)}</datalist>
          </div>
          {!readOnly && (
            <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
              <button type="button" className="btn-secondary btn-sm" onClick={addStep}>+ Add step</button>
            </div>
          )}
        </section>
      </fieldset>

      {!readOnly && (
        <div className="mo-panel mo-panel-pad mo-spread" style={{ position: 'sticky', bottom: 16 }}>
          <span className="mo-muted" style={{ fontSize: 14 }}>
            {id ? `Changes apply to new jobs only. ${runningJobs} job${runningJobs === 1 ? '' : 's'} already made from this workflow keep their steps.` : 'New jobs can use this workflow as soon as it is saved.'}
          </span>
          <div className="mo-row">
            {error && <span className="mo-error" role="alert">{error}</span>}
            {saved && !error && <span className="mo-muted" style={{ fontSize: 14 }}>Saved ✓</span>}
            {id && <button type="button" className="btn-secondary" disabled={pending} onClick={toggleArchive}>{archived ? 'Restore' : 'Archive'}</button>}
            <button type="button" className="btn-primary" disabled={pending} onClick={save}>{pending ? 'Saving…' : id ? 'Save workflow' : 'Create workflow'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
