'use client'

import { useOptimistic, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ImagePlus, X } from 'lucide-react'
import { updateProjectStage } from '@/lib/actions'
import {
  toggleLpChecklistItem, submitLpForInternalReview, addLpInternalFeedback,
  requestLpChanges, approveLpInternalReview, recordLpDiscount, sendLpToClientReview,
} from '@/lib/lp-review-actions'
import {
  LP_INTERNAL_REVIEWER, LP_STEP_META, LP_DISCOUNT_LABELS, NO_DISCOUNT_KEY,
  lpStageDisplay, lpStepOf, lpIsBuilding,
  type LpChecklistResult, type LpDiscount, type LpDiscountMode, type LpReviewEventKind, type LpSubmission,
} from '@/lib/lp-review'
import { LP_SECTIONS, normalizeStage, type Project, type ProjectComment } from '@/lib/types'
import { STAGE_COLORS } from '@/lib/stageColors'
import { createClient } from '@/lib/supabase/client'
import FeedbackComment from '@/components/FeedbackComment'

// The Landing Page tab's review flow — the UI half of lib/lp-review.ts.
//
//   LpNextStep            the one forward action, plus where the page sits in
//                         Build → Internal Review → Internal Revisions →
//                         Discount Creation → Client Review
//   LpChecklistPanel      what the team confirms before every submission
//   LpInternalReviewPanel the reviewer's notes, each ticked off when fixed
//   LpDiscountPanel       how the discount was set up before the client sees it
//
// Every button here is gated again on the server; the disabled states are only
// there so nobody has to click to find out.

type ActionResult = { ok: true } | { ok: false; error: string } | void

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
const scrollToId = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

// The discount setup guide has exactly one editor: Final output's. Everything
// else points at it instead of showing the guide a second time. With no guide
// yet its textarea is already open, so this lands the cursor in it.
function goToGuideEditor() {
  const box = document.getElementById('discount-guide')
  box?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  box?.querySelector('textarea')?.focus({ preventScroll: true })
}

/** One pending action at a time, with its error. */
function useAction() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState('')
  function run(fn: () => Promise<ActionResult>, after?: () => void) {
    setErr('')
    startTransition(async () => {
      try {
        const r = await fn()
        if (r && !r.ok) { setErr(r.error); return }
        after?.()
        router.refresh()
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      }
    })
  }
  return { pending, err, setErr, run }
}

function ErrorLine({ text }: { text: string }) {
  if (!text) return null
  return <div role="alert" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{text}</div>
}

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  fontSize: 12, fontWeight: 600, color: 'var(--accent)',
}

// ── Next step + flow ────────────────────────────────────────────────────────

const FLOW = ['build', 'review', 'revisions', 'discount', 'client'] as const

export function LpNextStep({
  project: p, checklist, openInternal, discount, disabled = false,
}: {
  project: Project
  checklist: LpChecklistResult
  openInternal: number
  discount: LpDiscount | null
  disabled?: boolean
}) {
  const { pending, err, run } = useAction()
  const stage = normalizeStage(p.lp_stage)
  const step = lpStepOf(p.lp_stage, p.lp_internal_step)
  const display = lpStageDisplay(p.lp_stage, p.lp_internal_step)
  const { done, total } = checklist

  let note = ''
  let action: { label: string; fn: () => Promise<ActionResult>; blocked: boolean } | null = null
  let jump: { id: string; label: string } | null = null

  if (disabled) {
    note = 'Complete.'
  } else if (stage === 'brief') {
    note = 'Nobody else will pick it up.'
    action = { label: 'Start work', fn: () => updateProjectStage(p.id, p.brand_id, 'lp_stage', 'in_progress'), blocked: false }
  } else if (stage === 'in_progress' || stage === 'revisions') {
    note = checklist.complete
      ? `Checklist done. ${LP_INTERNAL_REVIEWER} reviews it next.`
      : `Finish the pre-submission checklist to submit — ${done} of ${total} done.`
    action = {
      label: stage === 'revisions' ? 'Submit revisions for internal review' : 'Submit for internal review',
      fn: () => submitLpForInternalReview(p.id, p.brand_id),
      blocked: !checklist.complete,
    }
    jump = { id: 'checklist', label: 'Checklist ↓' }
  } else if (step === 'review') {
    note = `Waiting on ${LP_INTERNAL_REVIEWER}'s review. Notes for the team land in Internal review below.`
    jump = { id: 'internal-review', label: 'Internal review ↓' }
  } else if (step === 'revisions') {
    note = openInternal > 0
      ? `${plural(openInternal, 'internal note')} to fix — tick each one off as you go.`
      : !checklist.complete
        ? `Notes fixed. Finish the checklist to resubmit — ${done} of ${total} done.`
        : `All notes fixed. Resubmit it to ${LP_INTERNAL_REVIEWER}, or approve it in Internal review below.`
    action = {
      label: 'Resubmit for internal review',
      fn: () => submitLpForInternalReview(p.id, p.brand_id),
      blocked: openInternal > 0 || !checklist.complete,
    }
    jump = openInternal > 0 ? { id: 'internal-review', label: 'Internal notes ↓' } : { id: 'checklist', label: 'Checklist ↓' }
  } else if (step === 'discount') {
    note = discount
      ? `Discount: ${LP_DISCOUNT_LABELS[discount.mode].toLowerCase()}. Ready for the client.`
      : 'Approved internally. Record how the discount was set up, then send it to the client.'
    action = { label: 'Send to client review', fn: () => sendLpToClientReview(p.id, p.brand_id), blocked: !discount }
    jump = { id: 'discount', label: 'Discount ↓' }
  } else if (stage === 'client_review') {
    note = 'Waiting on the client.'
  } else if (stage === 'ready') {
    note = 'The ads are running.'
    action = { label: 'Mark live', fn: () => updateProjectStage(p.id, p.brand_id, 'lp_stage', 'live'), blocked: false }
  } else {
    note = 'Done.'
  }

  const live = !!action && !action.blocked && !disabled

  // Where the page sits on the review road. Client Revisions sits on "Build":
  // it is the same job — fix it, re-test it, submit it.
  const at =
    step === 'review' ? 1 : step === 'revisions' ? 2 : step === 'discount' ? 3
    : stage === 'client_review' ? 4 : stage === 'ready' || stage === 'live' ? 5 : 0
  const flowLabel: Record<(typeof FLOW)[number], string> = {
    build: stage === 'revisions' ? 'Client Revisions' : 'Build',
    review: LP_STEP_META.review.label,
    revisions: LP_STEP_META.revisions.label,
    discount: LP_STEP_META.discount.label,
    client: 'Client Review',
  }
  const flowColor: Record<(typeof FLOW)[number], string> = {
    build: (stage === 'revisions' ? STAGE_COLORS.revisions : STAGE_COLORS.in_progress).border,
    review: LP_STEP_META.review.colors.border,
    revisions: LP_STEP_META.revisions.colors.border,
    discount: LP_STEP_META.discount.colors.border,
    client: STAGE_COLORS.client_review.border,
  }

  return (
    <div style={{
      padding: '12px 16px', marginBottom: 20, borderRadius: 10,
      border: `1px solid ${live ? 'var(--accent)' : 'var(--border)'}`,
      background: live ? 'var(--accent-muted)' : 'var(--surface-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
            Landing page · <span style={{ color: display.colors.text, fontWeight: 700 }}>{display.label}</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3 }}>
            {note}
            {jump && <> <button type="button" onClick={() => scrollToId(jump.id)} style={linkBtn}>{jump.label}</button></>}
          </div>
        </div>

        {action && !disabled && (
          <button
            type="button"
            onClick={() => run(action.fn)}
            disabled={pending || action.blocked}
            title={action.blocked ? 'Not yet — see the note on the left.' : undefined}
            style={{
              flexShrink: 0, fontSize: 12.5, fontWeight: 700, padding: '9px 16px', borderRadius: 8,
              cursor: pending ? 'wait' : action.blocked ? 'not-allowed' : 'pointer',
              border: `1px solid ${action.blocked ? 'var(--border-strong)' : 'var(--accent)'}`,
              background: action.blocked ? 'var(--surface-2)' : 'var(--accent)',
              color: action.blocked ? 'var(--text-muted)' : '#fff',
            }}
          >{pending ? 'Saving…' : `${action.label} →`}</button>
        )}
      </div>

      {!disabled && (
        <ol aria-label="Landing page review steps" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {FLOW.map((key, i) => {
            const past = i < at
            const current = i === at
            const color = flowColor[key]
            return (
              <li key={key} aria-current={current ? 'step' : undefined} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, fontWeight: current ? 700 : 500, padding: '3px 9px', borderRadius: 999,
                color: current ? color : past ? 'var(--text-secondary)' : 'var(--text-muted)',
                background: current ? `color-mix(in srgb, ${color} 14%, transparent)` : 'transparent',
                border: `1px solid ${current ? `color-mix(in srgb, ${color} 45%, transparent)` : 'var(--border)'}`,
              }}>
                {past
                  ? <Check size={11} strokeWidth={3} aria-hidden />
                  : <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: current ? color : 'var(--border-strong)' }} />}
                {flowLabel[key]}
              </li>
            )
          })}
        </ol>
      )}

      <ErrorLine text={err} />
    </div>
  )
}

// ── Pre-submission checklist ────────────────────────────────────────────────

function Tick({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick?: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 20, height: 20, borderRadius: 5, flexShrink: 0, padding: 0, marginTop: 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        border: `1.5px solid ${on ? 'var(--success)' : 'var(--border-strong)'}`,
        background: on ? 'var(--success)' : 'transparent',
        color: '#fff',
      }}
    >{on && <Check size={12} strokeWidth={3} aria-hidden />}</button>
  )
}

export function LpChecklistPanel({
  project: p, checklist, submission, disabled = false,
}: {
  project: Project
  checklist: LpChecklistResult
  submission: LpSubmission | null
  disabled?: boolean
}) {
  const { pending, err, run } = useAction()
  const building = lpIsBuilding(p.lp_stage, p.lp_internal_step)
  const step = lpStepOf(p.lp_stage, p.lp_internal_step)

  // Manual ticks flip at once; the refresh that follows settles them.
  const base: Record<string, boolean> = Object.fromEntries(checklist.rows.map(r => [r.key, r.done]))
  base[NO_DISCOUNT_KEY] = !!checklist.rows.find(r => r.key === 'discount_guide')?.check
  const [ticks, setTick] = useOptimistic(base, (s, a: { key: string; on: boolean }) => ({ ...s, [a.key]: a.on }))

  function toggle(key: string, on: boolean) {
    run(async () => {
      setTick({ key, on })
      return toggleLpChecklistItem(p.id, p.brand_id, key, on)
    })
  }

  const hasGuide = !!p.shopify_coupon_code?.trim()
  const [showChecks, setShowChecks] = useState(false)

  if (!building) {
    const bypassed = step !== null && (!submission || submission.bypassed)
    if (bypassed) {
      return (
        <div style={{ padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--urgent-soon-bg)', color: 'var(--urgent-soon)', border: '1px solid var(--urgent-soon)' }}>
          This page reached Internal Review without the checklist — moved on the stage rail, or before the checklist existed.
        </div>
      )
    }
    if (!submission) {
      return (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Not open right now. It opens whenever the page is being built or fixed.
        </div>
      )
    }

    // A status row, not a sentence with an icon in it: Tailwind's preflight
    // makes every svg display:block, so an icon inline in text sat on a line
    // of its own above the words.
    const all = checklist.done === checklist.total
    const confirmed = checklist.rows.filter(r => r.done)
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span aria-hidden style={{
            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: all ? 'color-mix(in srgb, var(--success) 16%, transparent)' : 'var(--urgent-soon-bg)',
            color: all ? 'var(--success)' : 'var(--urgent-soon)',
          }}><Check size={15} strokeWidth={3} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
              {all ? `All ${checklist.total} checks confirmed` : `${checklist.done} of ${checklist.total} checks confirmed`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Submitted by {submission.by} · {fmt(submission.at)}
            </div>
          </div>
          <span style={{
            fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, flexShrink: 0,
            border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-secondary)',
          }}>{submission.deliverable === 'liquid' ? 'Liquid files' : 'Live URL'}</span>
          <button type="button" onClick={() => setShowChecks(v => !v)} aria-expanded={showChecks} style={{ ...linkBtn, flexShrink: 0 }}>
            {showChecks ? 'Hide checks' : 'Show checks'}
          </button>
        </div>

        {showChecks && (
          <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: '4px 0 0 40px', display: 'grid', gap: 6 }}>
            {confirmed.map(r => (
              <li key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                <Check size={12} strokeWidth={3} aria-hidden style={{ color: 'var(--success)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>{r.label}</span>
                {r.check && <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{r.check.by} · {fmt(r.check.at)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  const pct = checklist.total ? Math.round((checklist.done / checklist.total) * 100) : 0

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--surface-2)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: checklist.complete ? 'var(--success)' : 'var(--accent)', transition: 'width 0.2s' }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: checklist.complete ? 'var(--success)' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {checklist.done} of {checklist.total}
        </span>
      </div>

      {(step === 'revisions' || normalizeStage(p.lp_stage) === 'revisions') && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Ticks from the last round are kept. Untick anything the changes affected.
        </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {checklist.rows.map(row => {
          // Auto rows can't be ticked by hand — they tick when the thing
          // exists. Their box still answers a click by taking you to where
          // that thing is done, rather than sitting there looking broken.
          const noDiscount = !!ticks[NO_DISCOUNT_KEY]
          let on = row.kind === 'manual' ? !!ticks[row.key] : row.done
          let box: React.ReactNode
          if (row.kind === 'manual') {
            box = <Tick on={on} disabled={disabled || pending} onClick={() => toggle(row.key, !on)} label={row.label} />
          } else if (row.key === 'discount_guide') {
            on = hasGuide || noDiscount
            box = hasGuide
              ? <Tick on disabled label={`${row.label} — ticked because the guide is written`} />
              : <Tick
                  on={on}
                  disabled={disabled || pending}
                  // Ticked via "no discount": the box unticks that. Not ticked:
                  // it takes you to the guide editor in Final output — the only
                  // one, so the guide is never being edited in two places.
                  onClick={() => (noDiscount ? toggle(NO_DISCOUNT_KEY, false) : goToGuideEditor())}
                  label={noDiscount ? 'Untick "This page has no discount"' : 'Write the discount setup guide'}
                />
          } else {
            box = <Tick on={on} disabled={disabled || on} onClick={() => scrollToId('page')} label={on ? row.label : `${row.label} — go to Final output`} />
          }

          return (
            <li key={row.key} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
              {box}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{row.label}</span>
                  {row.kind === 'auto' && (
                    <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>ticks itself</span>
                  )}
                  {row.kind === 'manual' && row.check && on && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.check.by} · {fmt(row.check.at)}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 2 }}>
                  {row.key === 'discount_guide' && !hasGuide
                    ? 'Write how the discount should be set up in Shopify — it ticks once the guide is saved.'
                    : row.help}
                </div>

                {row.key === 'deliverable' && !row.done && (
                  <button type="button" onClick={() => scrollToId('page')} style={{ ...linkBtn, marginTop: 4 }}>Go to Final output ↑</button>
                )}
                {row.key === 'discount_guide' && !hasGuide && !disabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    {!noDiscount && (
                      <>
                        <button type="button" className="btn-secondary btn-sm" onClick={goToGuideEditor}>Write the guide ↑</button>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>or</span>
                      </>
                    )}
                    <Tick
                      on={noDiscount}
                      disabled={pending}
                      onClick={() => toggle(NO_DISCOUNT_KEY, !noDiscount)}
                      label="This page has no discount"
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>This page has no discount</span>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <ErrorLine text={err} />
    </div>
  )
}

// ── Internal review ─────────────────────────────────────────────────────────

const EVENT_LABELS: Record<LpReviewEventKind, string> = {
  submitted: 'Submitted',
  changes_requested: 'Changes requested',
  resubmitted: 'Resubmitted',
  approved: 'Approved',
}

interface PendingShot { url: string; preview: string }

export function LpInternalReviewPanel({
  project: p, feedback, submission, checklist, disabled = false,
}: {
  project: Project
  /** Internal LP notes (track 'lp', audience 'internal'), any order. */
  feedback: ProjectComment[]
  submission: LpSubmission | null
  /** For the resubmit button in Internal Revisions. */
  checklist: LpChecklistResult
  disabled?: boolean
}) {
  const { pending, err, setErr, run } = useAction()
  const step = lpStepOf(p.lp_stage, p.lp_internal_step)

  // A to-do list reads oldest first.
  const sorted = [...feedback].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const open = sorted.filter(c => !c.resolved_at)
  const done = sorted.filter(c => !!c.resolved_at)
  const [showDone, setShowDone] = useState(false)

  const [text, setText] = useState('')
  const [section, setSection] = useState<string>('General')
  const [shots, setShots] = useState<PendingShot[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Screenshots go where note attachments go (public project-images bucket):
  // they are pictures of a page the client is about to see anyway.
  async function addShots(files: File[]) {
    const images = files.filter(f => f.type.startsWith('image/'))
    if (!images.length) return
    setUploading(true)
    setErr('')
    const supabase = createClient()
    const added: PendingShot[] = []
    for (const file of images) {
      if (file.size > 10 * 1024 * 1024) { setErr('Each screenshot must be under 10MB.'); continue }
      const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
      const path = `lp-review-attachments/${p.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const { error } = await supabase.storage.from('project-images').upload(path, file)
      if (error) { setErr(error.message); continue }
      const { data } = supabase.storage.from('project-images').getPublicUrl(path)
      added.push({ url: data.publicUrl, preview: URL.createObjectURL(file) })
    }
    setShots(s => [...s, ...added])
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  function submitNote(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() && shots.length === 0) return
    run(
      () => addLpInternalFeedback(p.id, p.brand_id, {
        content: text,
        sectionTag: section === 'General' ? null : section,
        attachmentUrls: shots.map(s => s.url),
      }),
      () => { setText(''); setShots([]); setSection('General') },
    )
  }

  const history = submission?.history ?? []
  const canWrite = !disabled && step !== null

  return (
    <div>
      {history.length > 0 && (
        <ol aria-label="Review history" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, listStyle: 'none', margin: '0 0 16px', padding: 0 }}>
          {history.map((h, i) => (
            <li key={`${h.kind}-${h.at}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
              {i > 0 && <span aria-hidden style={{ color: 'var(--text-muted)' }}>→</span>}
              <span style={{ padding: '3px 9px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{EVENT_LABELS[h.kind]}</strong> · {h.by} · {fmt(h.at)}
              </span>
            </li>
          ))}
        </ol>
      )}

      {canWrite && (
        <form onSubmit={submitNote} style={{ marginBottom: 18, padding: 12, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            {/* margin/width reset: the global label and select styles assume a
                stacked form field, not an inline row. */}
            <label style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }} htmlFor="lp-note-section">Section</label>
            <select
              id="lp-note-section"
              value={section}
              onChange={e => setSection(e.target.value)}
              style={{ width: 'auto', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-primary)' }}
            >
              {LP_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            // Pasting a screenshot attaches it — the fastest way to point at a
            // spacing or a broken image.
            onPaste={e => {
              const files = Array.from(e.clipboardData.files ?? [])
              if (files.some(f => f.type.startsWith('image/'))) { e.preventDefault(); void addShots(files) }
            }}
            rows={3}
            placeholder="What needs to change? e.g. Mobile: the hero headline wraps onto four lines and pushes the button below the fold. Paste a screenshot to attach it."
            style={{ width: '100%', fontSize: 13, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-primary)', resize: 'vertical', fontFamily: 'inherit' }}
          />
          {shots.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {shots.map((s, i) => (
                <div key={s.url} style={{ position: 'relative' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.preview} alt={`Screenshot ${i + 1}`} style={{ width: 72, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }} />
                  <button
                    type="button"
                    aria-label="Remove screenshot"
                    onClick={() => setShots(list => list.filter(x => x.url !== s.url))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'var(--danger)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                  ><X size={11} aria-hidden /></button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => void addShots(Array.from(e.target.files ?? []))} />
            <button type="button" className="btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <ImagePlus size={13} aria-hidden style={{ marginRight: 4, verticalAlign: '-2px' }} />
              {uploading ? 'Uploading…' : 'Screenshot'}
            </button>
            <button type="submit" className="btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={pending || uploading || (!text.trim() && shots.length === 0)}>
              {pending ? 'Saving…' : 'Add note'}
            </button>
          </div>
        </form>
      )}

      {sorted.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          {step === 'review'
            ? 'No notes yet. Add one for anything that needs changing, or approve the page if it is ready.'
            : 'No internal notes on this page.'}
        </p>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            {open.length ? `${open.length} open` : 'All fixed ✓'}{done.length ? ` · ${done.length} done` : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {open.map(c => (
              <FeedbackComment key={c.id} comment={c} projectId={p.id} brandId={p.brand_id} canResolve={!disabled} showAttachments />
            ))}
          </div>
          {done.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button type="button" onClick={() => setShowDone(v => !v)} style={linkBtn}>
                {showDone ? 'Hide' : 'Show'} {plural(done.length, 'fixed note')}
              </button>
              {showDone && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {done.map(c => (
                    <FeedbackComment key={c.id} comment={c} projectId={p.id} brandId={p.brand_id} canResolve={!disabled} showAttachments />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {step === 'review' && !disabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 200 }}>
            {open.length
              ? 'Send the open notes back to the team, or tick off any that are fine.'
              : 'Nothing open. Approve it and it moves to discount creation.'}
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={pending || open.length === 0}
            onClick={() => run(() => requestLpChanges(p.id, p.brand_id))}
          >Request changes{open.length ? ` (${open.length})` : ''}</button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={pending || open.length > 0}
            title={open.length ? 'Tick off or send back the open notes first.' : undefined}
            onClick={() => run(() => approveLpInternalReview(p.id, p.brand_id))}
          >Approve → Discount creation</button>
        </div>
      )}

      {/* Internal Revisions: the way forward sits next to the notes it depends
          on. It used to be only in the bar at the top of the tab, so with every
          note ticked off this card offered nothing to click. The team
          resubmits; the reviewer can also approve on the spot. */}
      {step === 'revisions' && !disabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 200 }}>
            {open.length
              ? `${plural(open.length, 'note')} still to fix. Tick each one off once it is done.`
              : !checklist.complete
                ? <>All notes fixed. Finish the checklist to resubmit ({checklist.done} of {checklist.total}) <button type="button" onClick={() => scrollToId('checklist')} style={linkBtn}>↓</button> — or approve it now.</>
                : 'All notes fixed. Resubmit it for review, or approve it now.'}
          </span>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={pending || open.length > 0 || !checklist.complete}
            title={open.length ? 'Tick off every note first.' : !checklist.complete ? 'Finish the checklist first.' : undefined}
            onClick={() => run(() => submitLpForInternalReview(p.id, p.brand_id))}
          >Resubmit for internal review</button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={pending || open.length > 0}
            title={open.length ? 'Tick off every note first.' : undefined}
            onClick={() => run(() => approveLpInternalReview(p.id, p.brand_id))}
          >Approve → Discount creation</button>
        </div>
      )}

      <ErrorLine text={err} />
    </div>
  )
}

// ── Discount creation ───────────────────────────────────────────────────────

const DISCOUNT_HELP: Record<LpDiscountMode, string> = {
  team: `${LP_INTERNAL_REVIEWER} set it up in Shopify from the guide.`,
  client: 'We have no access, so the client sets it up. Note what they were sent.',
  none: 'The offer needs no discount code or automatic discount.',
}

export function LpDiscountPanel({
  project: p, discount, noDiscountTicked, disabled = false,
}: {
  project: Project
  discount: LpDiscount | null
  /** The team ticked "This page has no discount" instead of writing a guide. */
  noDiscountTicked: boolean
  disabled?: boolean
}) {
  const { pending, err, run } = useAction()
  const [editing, setEditing] = useState(!discount)
  const [mode, setMode] = useState<LpDiscountMode>(discount?.mode ?? (noDiscountTicked ? 'none' : 'team'))
  const [note, setNote] = useState(discount?.note ?? '')
  // The guide itself lives in Final output; repeating it here put the same
  // twenty lines on screen twice. One line to recognise it, and a jump to it.
  const guideFirstLine = p.shopify_coupon_code?.split('\n').find(l => l.trim())?.trim() ?? null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>Setup guide</span>
        {guideFirstLine ? (
          <>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {guideFirstLine}
            </span>
            <button type="button" onClick={() => scrollToId('discount-guide')} style={{ ...linkBtn, flexShrink: 0 }}>View full guide ↑</button>
          </>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {noDiscountTicked ? 'The team marked this page as having no discount.' : 'No setup guide was written.'}
          </span>
        )}
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        {!editing && discount ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <Check size={16} strokeWidth={3} aria-hidden style={{ color: 'var(--success)', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{LP_DISCOUNT_LABELS[discount.mode]}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Recorded by {discount.by} · {fmt(discount.at)}</div>
              {discount.note && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, whiteSpace: 'pre-wrap' }}>{discount.note}</div>}
            </div>
            {!disabled && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => { setMode(discount.mode); setNote(discount.note ?? ''); setEditing(true) }}>Change</button>
            )}
            {/* The last step, right where it is unlocked — not only in the bar
                at the top of the tab. */}
            {!disabled && lpStepOf(p.lp_stage, p.lp_internal_step) === 'discount' && (
              <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => run(() => sendLpToClientReview(p.id, p.brand_id))}>
                {pending ? 'Sending…' : 'Send to client review →'}
              </button>
            )}
          </div>
        ) : disabled ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No discount recorded.</div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); run(() => recordLpDiscount(p.id, p.brand_id, mode, note), () => setEditing(false)) }}>
            <div id="lp-discount-mode-label" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>How was the discount set up?</div>
            {/* Buttons acting as radios, not <label><input type="radio">: the
                app's global label (uppercase, block) and input (full width)
                styles turned those into shouting text with the dot floating
                mid-row. */}
            <div role="radiogroup" aria-labelledby="lp-discount-mode-label" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {(Object.keys(LP_DISCOUNT_LABELS) as LpDiscountMode[]).map(m => {
                const selected = mode === m
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setMode(m)}
                    style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', width: '100%',
                      cursor: 'pointer', padding: '10px 12px', borderRadius: 8, font: 'inherit',
                      border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                      background: selected ? 'var(--accent-muted)' : 'transparent',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <span aria-hidden style={{
                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                      border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {selected && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{LP_DISCOUNT_LABELS[m]}</span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{DISCOUNT_HELP[m]}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              placeholder="Code(s) and details, e.g. SUMMER20 — 20% off, ends Oct 31. Optional."
              style={{ width: '100%', marginTop: 10, fontSize: 13, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-primary)', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              {discount && <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>}
              <button type="submit" className="btn-primary btn-sm" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        )}
      </div>

      <ErrorLine text={err} />
    </div>
  )
}
