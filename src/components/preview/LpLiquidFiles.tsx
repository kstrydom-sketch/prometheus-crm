'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { BRAND_DOC_BUCKET } from '@/lib/brand-docs'
import {
  LIQUID_ACCEPT, LIQUID_CONTENT_TYPE, MAX_LIQUID_BYTES, liquidExt, type LpLiquidFile,
} from '@/lib/lp-review'
import {
  setLpLiquidReason, createLpLiquidUploadUrl, attachLpLiquidFile, getLpLiquidFileUrl, removeLpLiquidFile,
} from '@/lib/lp-review-actions'

// Handing a landing page in as Liquid files — the LAST RESORT, for clients
// whose Shopify we cannot get into. With store access the page is published
// and its URL goes in Final output; this is not offered at all once a URL is
// there. A reason is required before anything can be uploaded, so every
// Liquid hand-in says why it was one.
//
// Files go to the private brand-docs bucket through a signed upload URL (see
// lp-review-actions.ts). Every theme file is text, so every one is sent as
// text/plain — the one text type that bucket accepts.

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const kb = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`

export default function LpLiquidFiles({
  projectId, brandId, lpUrl, reason, files, disabled = false,
}: {
  projectId: string
  brandId: string
  lpUrl: string | null
  reason: string | null
  files: LpLiquidFile[]
  disabled?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(!!reason || files.length > 0)
  const [draft, setDraft] = useState(reason ?? '')
  const [editingReason, setEditingReason] = useState(!reason)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [viewing, setViewing] = useState<{ id: string; text: string } | null>(null)

  const hasUrl = !!lpUrl?.trim()
  // With a URL there is nothing to hand in as Liquid. Files left over from
  // before the URL arrived still show, so they can be removed.
  if (hasUrl && files.length === 0) return null

  function saveReason() {
    setErrors([])
    startTransition(async () => {
      const r = await setLpLiquidReason(projectId, brandId, draft)
      if (!r.ok) { setErrors([r.error]); return }
      setEditingReason(false)
      router.refresh()
    })
  }

  async function upload(list: File[]) {
    if (!list.length) return
    setBusy(true)
    setErrors([])
    const errs: string[] = []
    const supabase = createClient()
    for (const file of list) {
      if (!liquidExt(file.name)) { errs.push(`${file.name}: only .liquid, .json, .css and .js theme files.`); continue }
      if (file.size > MAX_LIQUID_BYTES) { errs.push(`${file.name}: over the ${MAX_LIQUID_BYTES / 1048576}MB limit.`); continue }
      try {
        const signed = await createLpLiquidUploadUrl(projectId, brandId, file.name, file.size)
        if (!signed.ok) { errs.push(`${file.name}: ${signed.error}`); continue }
        // Re-wrapped: uploadToSignedUrl sends a File's own type, and a .liquid
        // file has none the bucket accepts.
        const body = new File([file], file.name, { type: LIQUID_CONTENT_TYPE })
        const { error } = await supabase.storage
          .from(BRAND_DOC_BUCKET)
          .uploadToSignedUrl(signed.path, signed.token, body, { contentType: LIQUID_CONTENT_TYPE, cacheControl: '3600' })
        if (error) { errs.push(`${file.name}: ${error.message}`); continue }
        const attached = await attachLpLiquidFile(projectId, brandId, { path: signed.path, fileName: file.name, byteSize: file.size })
        if (!attached.ok) errs.push(`${file.name}: ${attached.error}`)
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : 'Upload failed.'}`)
      }
    }
    setBusy(false)
    setErrors(errs)
    router.refresh()
  }

  function view(f: LpLiquidFile) {
    if (viewing?.id === f.id) { setViewing(null); return }
    setErrors([])
    startTransition(async () => {
      const r = await getLpLiquidFileUrl(f.id, 'view')
      if (!r.ok) { setErrors([r.error]); return }
      try {
        const res = await fetch(r.url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setViewing({ id: f.id, text: await res.text() })
      } catch {
        setErrors([`Could not open ${f.file_name}. Try Download instead.`])
      }
    })
  }

  function download(f: LpLiquidFile) {
    setErrors([])
    startTransition(async () => {
      const r = await getLpLiquidFileUrl(f.id, 'download')
      if (!r.ok) { setErrors([r.error]); return }
      // Storage's ?download= sends Content-Disposition: attachment, so this
      // downloads without leaving the page (see BrandDocuments).
      window.location.href = r.url
    })
  }

  function remove(f: LpLiquidFile) {
    if (!window.confirm(`Remove ${f.file_name}? The file is deleted for everyone.`)) return
    setErrors([])
    startTransition(async () => {
      const r = await removeLpLiquidFile(f.id, projectId, brandId)
      if (!r.ok) { setErrors([r.error]); return }
      if (viewing?.id === f.id) setViewing(null)
      router.refresh()
    })
  }

  if (!open) {
    if (disabled) return null
    return (
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', textDecoration: 'underline', textUnderlineOffset: 3 }}
        >No access to the client&apos;s store? Hand in Liquid files instead</button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Liquid files{files.length ? ` · ${files.length}` : ''}
        </span>
        {!reason && files.length === 0 && !disabled && (
          <button type="button" onClick={() => setOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>Cancel</button>
        )}
      </div>

      {hasUrl ? (
        <div style={{ padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, marginBottom: 10, background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          This page has a URL now, so these files are no longer the hand-in. Remove them once nobody needs them.
        </div>
      ) : (
        <div style={{ padding: '10px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, marginBottom: 10, background: 'var(--urgent-soon-bg)', color: 'var(--urgent-soon)', border: '1px solid var(--urgent-soon)' }}>
          Last resort — only when we cannot get into the client&apos;s Shopify. If we have access, publish the page and paste its URL above instead.
        </div>
      )}

      {!hasUrl && (
        editingReason && !disabled ? (
          <div style={{ marginBottom: 10 }}>
            <label htmlFor="lp-liquid-reason" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              Why can&apos;t we publish it ourselves?
            </label>
            <textarea
              id="lp-liquid-reason"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={2}
              placeholder="e.g. Client hasn't given us staff access to their Shopify; they will install the section themselves."
              style={{ width: '100%', fontSize: 13, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-primary)', resize: 'vertical', fontFamily: 'inherit' }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
              {reason && <button type="button" className="btn-secondary btn-sm" onClick={() => { setDraft(reason); setEditingReason(false) }}>Cancel</button>}
              <button type="button" className="btn-primary btn-sm" disabled={pending || !draft.trim()} onClick={saveReason}>Save reason</button>
            </div>
          </div>
        ) : reason ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            <span style={{ color: 'var(--text-muted)' }}>Reason:</span>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{reason}</span>
            {!disabled && <button type="button" onClick={() => setEditingReason(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--accent)', padding: 0 }}>Edit</button>}
          </div>
        ) : null
      )}

      {!hasUrl && reason && !disabled && (
        // textTransform/letterSpacing/weight reset: the global label style is
        // for uppercase field captions, not a drop target's sentence.
        <label style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginBottom: 10, borderRadius: 8,
          border: '1px dashed var(--border-strong)', fontSize: 12, color: 'var(--text-secondary)',
          textTransform: 'none', letterSpacing: 0, fontWeight: 400,
          cursor: busy ? 'wait' : 'pointer',
        }}>
          <input
            type="file"
            accept={LIQUID_ACCEPT}
            multiple
            hidden
            disabled={busy}
            onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void upload(f) }}
          />
          {busy ? 'Uploading…' : 'Upload theme files — .liquid sections and snippets, .json templates, .css/.js assets'}
        </label>
      )}

      {files.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {files.map(f => (
            <li key={f.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>{f.file_name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {kb(f.byte_size)} · {f.uploaded_by_name ?? 'Someone'} · {fmt(f.created_at)}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                  <button type="button" onClick={() => view(f)} disabled={pending} style={rowBtn}>{viewing?.id === f.id ? 'Hide' : 'View'}</button>
                  <button type="button" onClick={() => download(f)} disabled={pending} style={rowBtn}>Download</button>
                  {!disabled && <button type="button" onClick={() => remove(f)} disabled={pending} style={{ ...rowBtn, color: 'var(--danger)' }}>Remove</button>}
                </span>
              </div>
              {viewing?.id === f.id && (
                <pre style={{
                  marginTop: 8, maxHeight: 360, overflow: 'auto', padding: '10px 12px', borderRadius: 8,
                  fontSize: 11.5, lineHeight: 1.5, background: 'var(--surface-2)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', whiteSpace: 'pre',
                }}>{viewing.text}</pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>
          {errors.map(e => <div key={e}>{e}</div>)}
        </div>
      )}
    </div>
  )
}

const rowBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--accent)',
}
