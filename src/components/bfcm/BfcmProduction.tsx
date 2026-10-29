'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DEFAULT_STEPS, STEP_STATUSES, stepStatusLabel, type ProductionStep } from '@/lib/bfcm/production'
import { setupProductionSteps, updateProductionStep, deleteProductionStep } from '@/lib/bfcm/production-actions'

type Counts = { statics: { total: number; detail: string }; motion: { total: number; detail: string } }
type Props = { slug: string; steps: ProductionStep[] | null; people: { id: string; name: string }[]; counts: Counts; today: string }

/** Staff-only: the steps after the plan. Each change saves on its own. */
export default function BfcmProduction({ slug, steps, people, counts, today }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true); setMessage('')
    const result = await action()
    if (!result.ok) setMessage(result.error ?? 'Unable to save.')
    router.refresh()
    setBusy(false)
  }
  const box = { margin: '20px 32px 0', padding: 18, border: '1px solid var(--border)', borderRadius: 10, fontSize: 13 } as const
  if (steps === null) return <section style={box}><strong>Production</strong><p style={{ margin: '8px 0 0' }}>Production steps are unavailable right now. The plan below is unaffected.</p></section>
  const missing = DEFAULT_STEPS.filter(d => !steps.some(s => s.kind === d.kind))
  const countFor = (kind: string) => kind === 'statics' ? counts.statics : kind === 'motion' ? counts.motion : null
  return <section style={box} aria-label="Production">
    <strong style={{ fontSize: 15 }}>Production</strong>
    {steps.length === 0 && <p style={{ margin: '8px 0 12px' }}>No production steps yet.</p>}
    {steps.length > 0 && <div style={{ overflowX: 'auto', marginTop: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}><th style={{ padding: '6px 8px' }}>Step</th><th style={{ padding: '6px 8px' }}>Owner</th><th style={{ padding: '6px 8px' }}>Due</th><th style={{ padding: '6px 8px' }}>Status</th><th /></tr></thead>
        <tbody>{steps.map(step => {
          const count = countFor(step.kind)
          const late = step.due_date && step.status !== 'done' && step.due_date < today
          const known = STEP_STATUSES.some(s => s.id === step.status)
          return <tr key={step.id} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={{ padding: '8px' }}>{step.title}{count && <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{count.total} · {count.detail}</div>}</td>
            <td style={{ padding: '8px' }}><select aria-label={`Owner: ${step.title}`} disabled={busy} value={step.owner_id ?? ''} onChange={e => void run(() => updateProductionStep(slug, step.id, { owner_id: e.target.value || null }))}>
              <option value="">Unassigned</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></td>
            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}><input type="date" aria-label={`Due: ${step.title}`} disabled={busy} value={step.due_date ?? ''} onChange={e => void run(() => updateProductionStep(slug, step.id, { due_date: e.target.value || null }))} />{late && <span style={{ color: 'var(--danger, #c0392b)', marginLeft: 6 }}>Late</span>}</td>
            <td style={{ padding: '8px' }}><select aria-label={`Status: ${step.title}`} disabled={busy} value={step.status} onChange={e => void run(() => updateProductionStep(slug, step.id, { status: e.target.value }))}>
              {!known && <option value={step.status}>{stepStatusLabel(step.status)}</option>}
              {STEP_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select></td>
            <td style={{ padding: '8px', textAlign: 'right' }}><button className="btn-secondary" disabled={busy} onClick={() => { if (window.confirm(`Remove “${step.title}” for this brand?`)) void run(() => deleteProductionStep(slug, step.id)) }}>Remove</button></td>
          </tr>
        })}</tbody>
      </table>
    </div>}
    {missing.length > 0 && <button className="btn-secondary" style={{ marginTop: 12 }} disabled={busy} onClick={() => void run(() => setupProductionSteps(slug))}>
      {steps.length === 0 ? 'Add production steps' : `Add back: ${missing.map(m => m.title).join(', ')}`}
    </button>}
    {message && <p role="alert" style={{ marginTop: 12 }}>{message}</p>}
  </section>
}
