'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addClientRule } from '@/lib/brands/actions'
import { RULE_AREAS, type RuleArea, type RuleWithMentions } from '@/lib/brands/profile'
import { AreaSelect } from './ClientRulesBoard'
import '@/components/jobs/jobs.css'
import './brand.css'

// Under one piece of client feedback: turn it into a standing rule for the
// brand, or record that the client was repeating a rule we already had. Most
// feedback is about that one piece and should stay where it is; this is for
// the part that will apply to the next one too.

export default function SaveAsRule({
  brandId, projectId, commentId, quote, rules, defaultArea = 'general',
}: {
  brandId: string
  projectId: string
  commentId: string
  quote: string
  rules: RuleWithMentions[]
  defaultArea?: RuleArea
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'new' | 'repeat'>('new')
  const [err, setErr] = useState('')
  const [pending, start] = useTransition()

  const linked = rules.find(r => r.mentions.some(m => m.project_comment_id === commentId))
  if (linked) {
    return <div className="cr-save cr-saved">✓ Client rule: {linked.rule}</div>
  }
  const active = rules.filter(r => r.status === 'active')

  if (!open) {
    return (
      <div className="cr-save">
        <button className="bp-link" style={{ fontSize: 13 }} onClick={() => setOpen(true)}>
          Applies beyond this piece? Save as client rule
        </button>
      </div>
    )
  }

  return (
    <form
      className="bp-form cr-save-box"
      action={fd => {
        setErr('')
        start(async () => {
          const r = await addClientRule(fd)
          if (!r.ok) { setErr(r.error); return }
          setOpen(false)
          router.refresh()
        })
      }}
    >
      <input type="hidden" name="brand_id" value={brandId} />
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="project_comment_id" value={commentId} />
      <input type="hidden" name="source" value="review" />
      <input type="hidden" name="quote" value={quote} />

      {active.length > 0 && (
        <div className="mo-seg" role="group" aria-label="New or repeated">
          <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>New rule</button>
          <button type="button" aria-pressed={mode === 'repeat'} onClick={() => setMode('repeat')}>They already told us this</button>
        </div>
      )}

      {mode === 'new' ? (
        <>
          <div>
            <label htmlFor={`sr-${commentId}`}>Rule for all future work</label>
            <textarea id={`sr-${commentId}`} name="rule" rows={2} required autoFocus
              placeholder="Rewrite it so it applies beyond this piece, e.g. “No lifestyle shots with pets.”" />
          </div>
          <div className="bp-form-row">
            <div>
              <label htmlFor={`sa-${commentId}`}>Applies to</label>
              <AreaSelect id={`sa-${commentId}`} defaultValue={defaultArea} />
            </div>
            <div>
              <label htmlFor={`sw-${commentId}`}>Their reason (optional)</label>
              <input id={`sw-${commentId}`} name="why" />
            </div>
          </div>
        </>
      ) : (
        <div>
          <label htmlFor={`se-${commentId}`}>Which rule</label>
          <select id={`se-${commentId}`} name="existing_rule_id" required defaultValue="">
            <option value="" disabled>Pick the rule they repeated</option>
            {active.map(r => <option key={r.id} value={r.id}>{RULE_AREAS[r.area].label}: {r.rule.slice(0, 90)}</option>)}
          </select>
          <p className="bp-purpose" style={{ fontSize: 13 }}>
            Counted against the rule, so the brand page shows how often the client has had to say it.
          </p>
        </div>
      )}
      {err && <p className="mo-error">{err}</p>}
      <div className="bp-actions">
        <button className="btn-primary" disabled={pending} style={{ fontSize: 13 }}>{pending ? 'Saving…' : mode === 'new' ? 'Save rule' : 'Record repeat'}</button>
        <button type="button" className="bp-link bp-link-muted" style={{ fontSize: 13 }} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}
