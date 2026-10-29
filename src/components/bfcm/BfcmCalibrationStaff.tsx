'use client'
import { useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Calibration, CalibrationFeedback, CalibrationItem } from '@/lib/bfcm/production-server'
import { attachCalibrationItem, createCalibrationUploadUrl, reopenCalibration, removeCalibrationItem, sendCalibration, startCalibration } from '@/lib/bfcm/calibration-actions'
import s from './BfcmProduction.module.css'

const BUCKET = 'project-images'
const BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' }
const ACCEPTED = new Set(Object.values(BY_EXT))
const typeOf = (file: File) => ACCEPTED.has(file.type) ? file.type : BY_EXT[(file.name.split('.').pop() || '').toLowerCase()] ?? null
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
export const CLIENT_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Not reviewed', color: 'var(--text-secondary)' },
  approved: { label: 'Looks good', color: 'var(--success)' },
  needs_changes: { label: 'Needs changes', color: 'var(--danger)' },
}
// Origin only exists in the browser; the server renders the path, the client fills in the rest without a mismatch.
const useOrigin = () => useSyncExternalStore(() => () => {}, () => window.location.origin, () => '')
const clientStatus = (status: string) => CLIENT_STATUS[status] ?? { label: status, color: 'var(--text-secondary)' }

type Props = { slug: string; data: { calibration: Calibration | null; items: CalibrationItem[]; feedback: CalibrationFeedback[] } | null; revisions: string | null }

/** Staff view of the client calibration round, inside the samples task. */
export default function BfcmCalibrationStaff({ slug, data, revisions }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const [copied, setCopied] = useState(false)
  const origin = useOrigin()

  async function act(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(label); setErrors([])
    const result = await action()
    if (!result.ok) setErrors([result.error ?? 'Something went wrong.'])
    router.refresh()
    setBusy(null)
  }
  async function upload(files: File[]) {
    const failed: string[] = []
    const supabase = createClient()
    for (const [i, file] of files.entries()) {
      setBusy(`Uploading ${i + 1} of ${files.length}: ${file.name}`)
      const type = typeOf(file)
      if (!type) { failed.push(`${file.name}: use JPG, PNG, WebP, GIF, MP4, MOV or WebM.`); continue }
      try {
        const signed = await createCalibrationUploadUrl(slug, type, file.size)
        if (!signed.ok) { failed.push(`${file.name}: ${signed.error}`); continue }
        // uploadToSignedUrl sends the File's own type and ignores contentType; re-wrap so a
        // blank browser type (common for .mov) can't be refused by the bucket.
        const body = file.type === type ? file : new File([file], file.name, { type })
        const { error } = await supabase.storage.from(BUCKET).uploadToSignedUrl(signed.path, signed.token, body, { contentType: type, cacheControl: '3600' })
        if (error) { failed.push(`${file.name}: ${error.message}`); continue }
        const attached = await attachCalibrationItem(slug, signed.path, file.name.replace(/\.[^.]+$/, ''), type)
        if (!attached.ok) failed.push(`${file.name}: ${attached.error}`)
      } catch (e) { failed.push(`${file.name}: ${e instanceof Error ? e.message : 'Upload failed.'}`) }
    }
    setErrors(failed); setBusy(null)
    router.refresh()
  }

  if (data === null) return <div className={s.box}><p className={s.muted} style={{ margin: 0 }}>Calibration is unavailable right now. Everything else on this page still works.</p></div>
  const { calibration, items, feedback } = data
  if (!calibration) return <div className={s.box} id="calibration">
    <div><strong>Client calibration</strong><p className={s.muted} style={{ margin: '4px 0 0' }}>Upload a few samples, send the client one link, and collect their notes on each before making the full set.</p></div>
    {revisions && <p className={s.muted} style={{ margin: 0 }}><strong>Contract revisions:</strong> {revisions}</p>}
    <div><button className="btn-primary btn-sm" disabled={!!busy} onClick={() => void act('start', () => startCalibration(slug))}>Start calibration</button></div>
    {errors.map(e => <p key={e} role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{e}</p>)}
  </div>

  const link = `${origin}/review/bfcm/${calibration.share_token}`
  const locked = calibration.status === 'submitted'
  const approved = items.filter(i => i.client_status === 'approved').length
  const changes = items.filter(i => i.client_status === 'needs_changes').length
  const statusLine = calibration.status === 'draft' ? 'Draft: only the team can see these samples.'
    : calibration.status === 'sent' ? `Sent ${day(calibration.sent_at)}. Waiting on the client.`
    : `${calibration.submitted_by_name ?? 'The client'} submitted feedback ${day(calibration.submitted_at)}.`

  return <div className={s.box} id="calibration">
    <div className={s.inline} style={{ justifyContent: 'space-between' }}>
      <div><strong>Client calibration</strong><div className={s.muted}>{statusLine}{items.length > 0 && calibration.status !== 'draft' && ` ${approved} look good · ${changes} need changes · ${items.length - approved - changes} not reviewed.`}</div></div>
      <div className={s.inline}>
        {calibration.status === 'draft' && <button className="btn-primary btn-sm" disabled={!!busy || !items.length} title={items.length ? undefined : 'Add samples first'} onClick={() => { if (window.confirm('Open the link for the client? They will see every sample here.')) void act('send', () => sendCalibration(slug)) }}>Send to client</button>}
        {calibration.status === 'sent' && <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => { if (window.confirm('Hide the samples from the client again? The link stays the same.')) void act('pull', () => reopenCalibration(slug, 'draft')) }}>Pull back</button>}
        {locked && <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => { if (window.confirm('Reopen so the client can change their feedback?')) void act('reopen', () => reopenCalibration(slug, 'sent')) }}>Reopen for the client</button>}
      </div>
    </div>
    {revisions && <p className={s.muted} style={{ margin: 0 }}><strong>Contract revisions:</strong> {revisions}</p>}
    <div className={s.inline}>
      <input className={s.linkField} readOnly value={link} aria-label="Client calibration link" onFocus={e => e.target.select()} />
      <button className="btn-secondary btn-sm" onClick={() => { void navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>{copied ? 'Copied' : 'Copy link'}</button>
    </div>
    {calibration.client_note && <div><p className={s.panelTitle}>Client’s overall note</p><p className={s.commentBody} style={{ margin: 0 }}>{calibration.client_note}</p></div>}
    {!locked && <label className={s.drop} data-over={over} onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); if (!busy) void upload([...e.dataTransfer.files]) }}>
      <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.mov,.m4v" hidden disabled={!!busy} onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) void upload(files) }} />
      {busy?.startsWith('Uploading') ? busy : 'Drop samples here, or click to choose. Images up to 50MB, videos up to 250MB.'}
    </label>}
    {items.length > 0 && <div className={s.grid}>{items.map(item => {
      const notes = feedback.filter(f => f.item_id === item.id)
      const pins = notes.filter(f => f.pin_x != null && f.pin_y != null)
      const st = clientStatus(item.client_status)
      return <div key={item.id} className={s.tile}>
        <div className={s.thumb}>
          {item.media_type === 'video' ? <video src={item.url} controls muted playsInline preload="metadata" /> : <img src={item.url} alt={item.name} loading="lazy" />}
          {item.media_type === 'image' && pins.map((p, i) => <span key={p.id} className={s.pin} style={{ left: `${p.pin_x}%`, top: `${p.pin_y}%` }} title={p.body}>{i + 1}</span>)}
        </div>
        <div className={s.tileBody}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.name}>{item.name}</strong>
          {calibration.status !== 'draft' && <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>}
          {notes.map(n => <span key={n.id}><strong>{n.pin_x != null ? `${pins.indexOf(n) + 1}. ` : ''}{n.author_name}:</strong> {n.body}</span>)}
          {!locked && <button className={s.linkBtn} style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => { if (window.confirm(`Remove “${item.name}”?${notes.length ? ' Its client comments go with it.' : ''}`)) void act('remove', () => removeCalibrationItem(slug, item.id)) }}>Remove</button>}
        </div>
      </div>
    })}</div>}
    {errors.map(e => <p key={e} role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{e}</p>)}
  </div>
}
