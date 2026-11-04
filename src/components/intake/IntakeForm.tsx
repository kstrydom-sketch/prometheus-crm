'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'
import { BRAND_DOC_ACCEPT, BRAND_DOC_BUCKET, MAX_BRAND_DOC_BYTES, MB, resolveDocType } from '@/lib/brand-docs'
import { CHANNELS, type Channel } from '@/lib/brands/profile'
import { AI_CHOICES, intakeCompleteness, type IntakeForm } from '@/lib/brands/intake'
import { attachIntakeFile, createIntakeUploadUrl, removeIntakeFile, saveIntake } from '@/lib/brands/intake-actions'

// The page a new client fills in. Written for someone on their phone between
// meetings: every answer saves itself, files go up by tap or drop, nothing is
// required, and they can come back to the same link to add more.

export interface IntakeFile {
  id: string
  file_name: string
  kind: string
  byte_size: number
  from_client: boolean
}

const SLOTS = [
  { kind: 'logo', title: 'Logo', hint: 'Vector if you have it (SVG, AI, EPS, PDF), plus a PNG. Light and dark versions if they exist.' },
  { kind: 'product_images', title: 'Product images', hint: 'The highest quality you have: packshots on plain backgrounds, lifestyle shots, close-ups. Select many at once.' },
  { kind: 'fonts', title: 'Fonts', hint: 'Font files (OTF, TTF, WOFF) or a .zip. No files? Just type the names below.' },
  { kind: 'guidelines', title: 'Brand guidelines / brand book', hint: 'Your brand book or style guide, usually a PDF.' },
  { kind: 'other', title: 'Anything else useful', hint: 'Product sheets, price lists, past ads you loved, reviews.' },
] as const

const AUTOSAVE_MS = 900

export default function IntakeFormView({
  token, brandName, initial, files: initialFiles, submittedAt,
}: {
  token: string
  brandName: string
  initial: IntakeForm
  files: IntakeFile[]
  submittedAt: string | null
}) {
  const [form, setForm] = useState<IntakeForm>(initial)
  const [files, setFiles] = useState<IntakeFile[]>(initialFiles)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveErr, setSaveErr] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const first = useRef(true)

  // Autosave: every change, debounced. Nothing the client types is lost to a
  // closed tab.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setSaveState('saving')
    const t = setTimeout(async () => {
      const r = await saveIntake(token, form, false)
      if (r.ok) { setSaveState('saved'); setSaveErr('') } else { setSaveState('error'); setSaveErr(r.error) }
    }, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [form, token])

  const set = <K extends keyof IntakeForm>(k: K, v: IntakeForm[K]) => setForm(f => ({ ...f, [k]: v }))

  const items = useMemo(() => intakeCompleteness({
    form, docKinds: files.map(f => f.kind), hasGuidelineText: false,
    aiSensitivity: form.ai, activeRuleCount: 0, contactCount: 0, preferredChannel: form.channel || null,
  }), [form, files])
  const doneCount = items.filter(i => i.done).length

  function submit() {
    start(async () => {
      const r = await saveIntake(token, form, true)
      if (r.ok) { setDone(r.savedAt); window.scrollTo({ top: 0, behavior: 'smooth' }) }
      else { setSaveState('error'); setSaveErr(r.error) }
    })
  }

  const swatches = useMemo(() => Array.from(new Set(form.colours.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? [])).slice(0, 12), [form.colours])

  return (
    <div className="ik-page">
      <header className="ik-top">
        <div className="ik-top-inner">
          <span className="ik-brand">{brandName}</span>
          <span className={`ik-save ik-save-${saveState}`} aria-live="polite">
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'All changes saved' : saveState === 'error' ? 'Not saved' : 'Saves as you type'}
          </span>
        </div>
        <div className="ik-progress" aria-label={`${doneCount} of ${items.length} answered`}>
          <div style={{ width: `${(doneCount / items.length) * 100}%` }} />
        </div>
      </header>

      <main className="ik-main">
        {done ? (
          <div className="ik-card ik-thanks">
            <h2>Thank you! 🎉</h2>
            <p>The team has everything you sent. You can come back to this same link any time to add or change something; it saves as you go.</p>
            <button className="ik-btn-secondary" onClick={() => setDone(null)}>OK</button>
          </div>
        ) : null}

        <section className="ik-intro">
          <h1>Let&apos;s get {brandName} set up</h1>
          <p>
            This is everything our designers, copywriters and editors need before they start. It takes about 10 minutes.
            Skip anything you don&apos;t have; it all saves automatically, and you can come back to this link later.
          </p>
          <p className="ik-count"><b>{doneCount} of {items.length}</b> done{doneCount < items.length && <> · still to go: {items.filter(i => !i.done).map(i => i.label.toLowerCase()).join(', ')}</>}</p>
        </section>

        {saveState === 'error' && <div className="ik-alert">{saveErr}</div>}

        {/* 1. Files */}
        <section className="ik-card">
          <h2><span className="ik-step">1</span> Your brand files</h2>
          <p className="ik-help">Tap a box to pick files, or drag them in. Up to {MAX_BRAND_DOC_BYTES / MB}MB each.</p>
          <div className="ik-slots">
            {SLOTS.map(s => (
              <UploadSlot
                key={s.kind}
                token={token}
                kind={s.kind}
                title={s.title}
                hint={s.hint}
                files={files.filter(f => f.kind === s.kind)}
                onAdded={f => setFiles(fs => [...fs, f])}
                onRemoved={id => setFiles(fs => fs.filter(f => f.id !== id))}
              />
            ))}
          </div>
          <label className="ik-field">
            <span>Files too big, or already in a folder? Paste a link instead</span>
            <textarea rows={2} value={form.asset_links} onChange={e => set('asset_links', e.target.value)}
              placeholder="Google Drive, Dropbox or WeTransfer link to your product photos, logo pack, etc." />
          </label>
        </section>

        {/* 2. Look */}
        <section className="ik-card">
          <h2><span className="ik-step">2</span> Colours &amp; fonts</h2>
          <label className="ik-field">
            <span>Brand colours</span>
            <input value={form.colours} onChange={e => set('colours', e.target.value)} placeholder="e.g. #0E3B2E forest green, #F4EDE4 cream, #E8743B accent" />
            <small>Hex codes if you have them, or just describe them.</small>
            {swatches.length > 0 && (
              <div className="ik-swatches">{swatches.map(c => <span key={c} title={c} style={{ background: c }} />)}</div>
            )}
          </label>
          <label className="ik-field">
            <span>Fonts you use</span>
            <input value={form.fonts} onChange={e => set('fonts', e.target.value)} placeholder="e.g. Headlines: Canela, Body: Inter" />
          </label>
        </section>

        {/* 3. AI */}
        <section className="ik-card">
          <h2><span className="ik-step">3</span> Are you OK with us using AI?</h2>
          <p className="ik-help">We sometimes use AI to create or touch up images and draft copy. Some brands love it, some don&apos;t want it at all. Either is fine; we just need to know.</p>
          <div className="ik-choices" role="radiogroup" aria-label="AI use">
            {AI_CHOICES.map(c => (
              <button key={c.v} type="button" role="radio" aria-checked={form.ai === c.v}
                className={`ik-choice${form.ai === c.v ? ' on' : ''}`} onClick={() => set('ai', form.ai === c.v ? null : c.v)}>
                <b>{c.label}</b>
                <span>{c.hint}</span>
              </button>
            ))}
          </div>
          <label className="ik-field">
            <span>Anything specific? (optional)</span>
            <input value={form.ai_note} onChange={e => set('ai_note', e.target.value)} placeholder="e.g. AI backgrounds are fine, but never change the product itself" />
          </label>
        </section>

        {/* 4. Voice and don'ts */}
        <section className="ik-card">
          <h2><span className="ik-step">4</span> How you sound, and what to avoid</h2>
          <label className="ik-field">
            <span>Describe your brand voice</span>
            <textarea rows={3} value={form.voice} onChange={e => set('voice', e.target.value)} placeholder="e.g. Warm, a little cheeky, never salesy. We talk like a friend who knows skincare." />
          </label>
          <label className="ik-field">
            <span>Words, claims or phrases we should never use</span>
            <textarea rows={4} value={form.copy_donts} onChange={e => set('copy_donts', e.target.value)} placeholder={'One per line, e.g.\nNever say "cure" or "anti-ageing"\nNo "cheap": say "great value"'} />
            <small>One per line. Each becomes a rule the whole team sees.</small>
          </label>
          <label className="ik-field">
            <span>Visual don&apos;ts</span>
            <textarea rows={3} value={form.design_donts} onChange={e => set('design_donts', e.target.value)} placeholder={'One per line, e.g.\nNo product on a pure white background\nNever crop the logo'} />
          </label>
        </section>

        {/* 5. Offer and products */}
        <section className="ik-card">
          <h2><span className="ik-step">5</span> Your offer &amp; products</h2>
          <label className="ik-field">
            <span>Offer basics</span>
            <textarea rows={3} value={form.offer} onChange={e => set('offer', e.target.value)} placeholder="What you usually run (e.g. 20% off sitewide, free shipping over $50, bundles), and what you never do." />
          </label>
          <label className="ik-field">
            <span>Product list</span>
            <textarea rows={5} value={form.products} onChange={e => set('products', e.target.value)} placeholder={'One per line, hero products first, e.g.\nVitamin C Serum, $48 (best seller)\nNight Repair Cream, $62'} />
            <small>Or upload a product sheet in &quot;Anything else useful&quot; above.</small>
          </label>
        </section>

        {/* 6. People */}
        <section className="ik-card">
          <h2><span className="ik-step">6</span> Who we talk to</h2>
          {form.contacts.map((c, i) => (
            <div key={i} className="ik-contact">
              <div className="ik-contact-head">
                <b>{i === 0 ? 'Main contact' : `Contact ${i + 1}`}</b>
                {i > 0 && <button type="button" className="ik-link" onClick={() => set('contacts', form.contacts.filter((_, j) => j !== i))}>Remove</button>}
              </div>
              <div className="ik-grid">
                {(['name', 'role', 'email', 'phone'] as const).map(k => (
                  <input key={k} aria-label={k} value={c[k]} type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'}
                    placeholder={{ name: 'Name', role: 'Role, e.g. Founder, approves offers', email: 'Email', phone: 'Phone (optional)' }[k]}
                    onChange={e => set('contacts', form.contacts.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))} />
                ))}
              </div>
            </div>
          ))}
          {form.contacts.length < 6 && (
            <button type="button" className="ik-link" onClick={() => set('contacts', [...form.contacts, { name: '', role: '', email: '', phone: '' }])}>+ Add another person</button>
          )}
          <label className="ik-field" style={{ marginTop: 18 }}>
            <span>Best way to reach you</span>
            <div className="ik-pills">
              {(Object.entries(CHANNELS) as Array<[Channel, string]>).map(([k, v]) => (
                <button key={k} type="button" className={`ik-pill${form.channel === k ? ' on' : ''}`} aria-pressed={form.channel === k}
                  onClick={() => set('channel', form.channel === k ? '' : k)}>{v}</button>
              ))}
            </div>
            <input value={form.channel_details} onChange={e => set('channel_details', e.target.value)} placeholder="Where exactly, e.g. Slack #brand-mm, WhatsApp +1 555…, replies mornings EST" />
          </label>
        </section>

        <section className="ik-card">
          <label className="ik-field">
            <span>Anything else we should know?</span>
            <textarea rows={3} value={form.anything_else} onChange={e => set('anything_else', e.target.value)} placeholder="Launches coming up, competitors you admire, past campaigns that worked…" />
          </label>
        </section>

        <div className="ik-submit">
          <button className="ik-btn" onClick={submit} disabled={pending}>{pending ? 'Sending…' : submittedAt || done ? 'Send updates' : "I'm done, send it"}</button>
          <p>Your answers are already saved. This lets the team know you&apos;re finished.</p>
        </div>
      </main>
    </div>
  )
}

function UploadSlot({
  token, kind, title, hint, files, onAdded, onRemoved,
}: {
  token: string
  kind: string
  title: string
  hint: string
  files: IntakeFile[]
  onAdded: (f: IntakeFile) => void
  onRemoved: (id: string) => void
}) {
  const [busy, setBusy] = useState<{ n: number; of: number; name: string } | null>(null)
  const [errs, setErrs] = useState<string[]>([])
  const [drag, setDrag] = useState(false)

  async function upload(list: File[]) {
    if (!list.length || busy) return
    const out: string[] = []
    const supabase = createClient()
    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      setBusy({ n: i + 1, of: list.length, name: file.name })
      const type = resolveDocType(file)
      if (!type) { out.push(`${file.name}: this file type isn't accepted. Try PDF, PNG, JPG, SVG, AI/EPS, a font or a .zip.`); continue }
      if (file.size > MAX_BRAND_DOC_BYTES) { out.push(`${file.name}: over ${MAX_BRAND_DOC_BYTES / MB}MB. Paste a Drive or Dropbox link below instead.`); continue }
      try {
        const signed = await createIntakeUploadUrl(token, kind, type, file.size)
        if (!signed.ok) { out.push(`${file.name}: ${signed.error}`); continue }
        // Re-wrapped so the bytes carry the type we resolved (see BrandDocuments).
        const body = file.type === type ? file : new File([file], file.name, { type })
        const { error } = await supabase.storage.from(BRAND_DOC_BUCKET)
          .uploadToSignedUrl(signed.path, signed.token, body, { contentType: type, cacheControl: '3600' })
        if (error) { out.push(`${file.name}: upload failed, try again.`); continue }
        const att = await attachIntakeFile(token, { path: signed.path, fileName: file.name, contentType: type, byteSize: file.size, kind })
        if (!att.ok) { out.push(`${file.name}: ${att.error}`); continue }
        onAdded({ id: att.id, file_name: file.name, kind, byte_size: file.size, from_client: true })
      } catch {
        out.push(`${file.name}: upload failed, try again.`)
      }
    }
    setBusy(null)
    setErrs(out)
  }

  async function remove(f: IntakeFile) {
    const r = await removeIntakeFile(token, f.id)
    if (r.ok) onRemoved(f.id)
    else setErrs([r.error])
  }

  return (
    <div className={`ik-slot${files.length ? ' has' : ''}`}>
      <label
        className={`ik-drop${drag ? ' drag' : ''}${busy ? ' busy' : ''}`}
        onDragOver={e => { e.preventDefault(); if (!busy) setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); void upload(Array.from(e.dataTransfer.files ?? [])) }}
      >
        <input type="file" multiple accept={BRAND_DOC_ACCEPT} disabled={!!busy} hidden
          onChange={e => { const l = Array.from(e.target.files ?? []); e.target.value = ''; void upload(l) }} />
        <span className="ik-drop-icon" aria-hidden>{files.length ? '✓' : '+'}</span>
        <span className="ik-drop-text">
          <b>{title}</b>
          <span>{busy ? `Uploading ${busy.name} (${busy.n} of ${busy.of})…` : hint}</span>
        </span>
      </label>
      {files.length > 0 && (
        <ul className="ik-files">
          {files.map(f => (
            <li key={f.id}>
              <span className="ik-file-name" title={f.file_name}>{f.file_name}</span>
              <span className="ik-file-size">{f.byte_size >= MB ? `${(f.byte_size / MB).toFixed(1)}MB` : `${Math.max(1, Math.round(f.byte_size / 1024))}KB`}</span>
              {f.from_client
                ? <button type="button" className="ik-link" onClick={() => remove(f)} aria-label={`Remove ${f.file_name}`}>Remove</button>
                : <span className="ik-file-size">on file</span>}
            </li>
          ))}
        </ul>
      )}
      {errs.map(e => <p key={e} className="ik-err">{e}</p>)}
    </div>
  )
}
