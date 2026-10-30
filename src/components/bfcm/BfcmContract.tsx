'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { BRAND_DOC_BUCKET, MAX_BRAND_DOC_BYTES, resolveDocType } from '@/lib/brand-docs'
import { attachBrandDocument, createBrandDocumentUploadUrl, getBrandDocumentUrl } from '@/lib/actions'
import { deleteContract, readContract, saveContract } from '@/lib/bfcm/contract-actions'
import type { BrandContract } from '@/lib/bfcm/production-server'
import s from './BfcmProduction.module.css'

type Doc = { id: string; file_name: string }
type Form = { id: string | null; document_id: string | null; title: string; signed_on: string; deliverables: string; revisions: string; special_terms: string }
const blank: Form = { id: null, document_id: null, title: '', signed_on: '', deliverables: '', revisions: '', special_terms: '' }
const day = (d: string | null) => d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null

/** The brand's contracts. The signed file lives in the brand's Documents; this keeps the terms the team works from. */
export default function BfcmContract({ brandId, contracts, documents }: { brandId: string | null; contracts: BrandContract[] | null; documents: Doc[] }) {
  const router = useRouter()
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [docs, setDocs] = useState(documents)

  if (!brandId) return <div className={s.box}><strong>Contract</strong><p className={s.muted} style={{ margin: 0 }}>This plan isn’t linked to a CRM brand, so there’s nowhere to keep its contract.</p></div>
  if (contracts === null) return <div className={s.box}><strong>Contract</strong><p className={s.muted} style={{ margin: 0 }}>Contracts are unavailable right now.</p></div>
  const set = (patch: Partial<Form>) => setForm(f => f && { ...f, ...patch })

  async function uploadFile(file: File) {
    if (!brandId) return
    setError('')
    const type = resolveDocType(file)
    if (!type) { setError('Contracts can be PDF, Word, or TXT files.'); return }
    if (file.size > MAX_BRAND_DOC_BYTES) { setError('That file is too large.'); return }
    setBusy('Uploading…')
    try {
      const signed = await createBrandDocumentUploadUrl(brandId, type, file.size)
      if (!signed.ok) { setError(signed.error); return }
      const body = file.type === type ? file : new File([file], file.name, { type })
      const { error: upErr } = await createClient().storage.from(BRAND_DOC_BUCKET).uploadToSignedUrl(signed.path, signed.token, body, { contentType: type, cacheControl: '3600' })
      if (upErr) { setError(upErr.message); return }
      const attached = await attachBrandDocument(brandId, { path: signed.path, fileName: file.name, contentType: type, byteSize: file.size })
      if (!attached.ok) { setError(attached.error); return }
      setDocs(d => [{ id: attached.documentId, file_name: file.name }, ...d])
      set({ document_id: attached.documentId, title: form?.title || file.name.replace(/\.[^.]+$/, '') })
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.') } finally { setBusy(null) }
  }
  async function aiRead() {
    if (!brandId || !form?.document_id) return
    setBusy('Reading the contract…'); setError('')
    const result = await readContract(brandId, form.document_id)
    if (result.ok) set({ ...result.fields, title: result.fields.title || form.title })
    else setError(result.error)
    setBusy(null)
  }
  async function save() {
    if (!brandId || !form) return
    setBusy('Saving…'); setError('')
    const result = await saveContract(brandId, form.id, form.document_id, { ...form, signed_on: form.signed_on || null })
    if (result.ok) { setForm(null); router.refresh() } else setError(result.error)
    setBusy(null)
  }
  async function open(documentId: string) {
    const result = await getBrandDocumentUrl(documentId, 'view')
    if (result.ok) window.open(result.url, '_blank', 'noopener,noreferrer'); else setError(result.error)
  }
  async function remove(c: BrandContract) {
    if (!brandId || !window.confirm(`Remove the “${c.title}” summary? The signed file stays in the brand’s Documents.`)) return
    const result = await deleteContract(brandId, c.id)
    if (result.ok) router.refresh(); else setError(result.error)
  }

  return <div className={s.box} id="contract">
    <div className={s.inline} style={{ justifyContent: 'space-between' }}>
      <strong>Contract</strong>
      {!form && <button className="btn-secondary btn-sm" onClick={() => setForm(blank)}>Add contract</button>}
    </div>
    {!form && contracts.length === 0 && <p className={s.muted} style={{ margin: 0 }}>No contract yet. Add the signed SOW so deliverables and revision terms sit next to the work.</p>}
    {!form && contracts.map(c => <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={s.inline} style={{ justifyContent: 'space-between' }}>
        <span><strong>{c.title}</strong>{c.signed_on && <span className={s.muted}> · {day(c.signed_on)}</span>}</span>
        <span className={s.inline}>
          {c.document_id && <button className={s.linkBtn} onClick={() => void open(c.document_id!)}>View {c.file_name ?? 'file'}</button>}
          <button className={s.linkBtn} onClick={() => setForm({ id: c.id, document_id: c.document_id, title: c.title, signed_on: c.signed_on ?? '', deliverables: c.deliverables, revisions: c.revisions, special_terms: c.special_terms })}>Edit</button>
          <button className={s.linkBtn} onClick={() => void remove(c)}>Remove</button>
        </span>
      </div>
      <dl className={s.terms}>
        <dt>Deliverables</dt><dd>{c.deliverables || '—'}</dd>
        <dt>Revisions</dt><dd>{c.revisions || '—'}</dd>
        <dt>Special terms</dt><dd>{c.special_terms || '—'}</dd>
      </dl>
      <span className={s.faint}>Last saved by {c.updated_by_name ?? 'the team'}</span>
    </div>)}
    {form && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className={s.inline}>
        <label className={`btn-secondary btn-sm ${s.fileButton}`}>
          Upload signed file
          <input type="file" hidden accept=".pdf,.docx,.txt,application/pdf" disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadFile(f) }} />
        </label>
        {docs.length > 0 && <select className={s.input} style={{ flex: '0 1 280px' }} value={form.document_id ?? ''} onChange={e => set({ document_id: e.target.value || null })} aria-label="Contract file">
          <option value="">No file linked</option>
          {docs.map(d => <option key={d.id} value={d.id}>{d.file_name}</option>)}
        </select>}
        <button className="btn-secondary btn-sm" disabled={!!busy || !form.document_id} onClick={() => void aiRead()} title={form.document_id ? 'Fills the fields below from the file. Check them before saving.' : 'Link a file first'}>Read with AI</button>
        {busy && <span className={s.muted}>{busy}</span>}
      </div>
      <label className={s.field}>Name<input className={s.input} value={form.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Marketing Moments + BFCM SOW, Oct 2026" /></label>
      <label className={s.field}>Effective date<input className={s.input} type="date" value={form.signed_on} onChange={e => set({ signed_on: e.target.value })} style={{ maxWidth: 200 }} /></label>
      <label className={s.field}>Deliverables<textarea className={s.textarea} rows={3} value={form.deliverables} onChange={e => set({ deliverables: e.target.value })} /></label>
      <label className={s.field}>Revisions promised<textarea className={s.textarea} rows={2} value={form.revisions} onChange={e => set({ revisions: e.target.value })} /></label>
      <label className={s.field}>Special terms<textarea className={s.textarea} rows={3} value={form.special_terms} onChange={e => set({ special_terms: e.target.value })} /></label>
      <div className={s.inline}>
        <button className="btn-primary btn-sm" disabled={!!busy || !form.title.trim()} onClick={() => void save()}>Save contract</button>
        <button className="btn-secondary btn-sm" disabled={!!busy} onClick={() => { setForm(null); setError('') }}>Cancel</button>
      </div>
    </div>}
    {error && <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
  </div>
}
