'use client'
import { useState } from 'react'
import { createBfcmAccessLink, revokeBfcmAccessLink } from '@/lib/bfcm/actions'

/** Internal staff control only. No link is created on mount or shared automatically. */
export default function BfcmAccess({ slug }: { slug: string }) {
  const [path, setPath] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function generate() {
    if (!window.confirm('Generate a private link for this plan? Any previous BFCM link for this brand will be revoked. Nothing will be sent to the client.')) return
    setBusy(true); setMessage('')
    const result = await createBfcmAccessLink(slug)
    if (result.ok) { setPath(`${window.location.origin}${result.path}`); setMessage('Private link created. Keep it safe: the CRM stores only its hash. Nothing was sent.') }
    else setMessage(result.error)
    setBusy(false)
  }
  async function revoke() {
    if (!window.confirm('Revoke this plan’s private link? Anyone using it will lose access.')) return
    setBusy(true)
    const result = await revokeBfcmAccessLink(slug)
    if (result.ok) { setPath(''); setMessage('Link revoked.') } else setMessage(result.error ?? 'Could not revoke the link.')
    setBusy(false)
  }
  return <details style={{ margin: '20px 32px 0', padding: 14, border: '1px solid var(--border)', borderRadius: 10, fontSize: 13 }}>
    <summary style={{ cursor: 'pointer' }}>Private client access · staff controls</summary>
    <p style={{ margin: '12px 0' }}>This link grants access to this plan only. Do not publish it. Creating or revoking a link does not send any messages.</p>
    <button className="btn-secondary" disabled={busy} onClick={()=>void generate()}>Create / replace link</button>{' '}
    <button className="btn-secondary" disabled={busy} onClick={()=>void revoke()}>Revoke link</button>
    {path && <label style={{ display: 'block', marginTop: 12 }}>Private link <input aria-label="Private client link" readOnly value={path} onFocus={e=>e.target.select()} style={{ display: 'block', width: '100%', padding: 10 }} /></label>}
    {message && <p role="status" style={{ marginTop: 12 }}>{message}</p>}
  </details>
}
