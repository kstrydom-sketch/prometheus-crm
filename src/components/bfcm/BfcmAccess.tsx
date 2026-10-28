'use client'
import { useState } from 'react'
import { createBfcmAccessLink, revokeBfcmAccessLink } from '@/lib/bfcm/actions'

/** Internal staff control only. No link is created on mount or shared automatically. */
export default function BfcmAccess({ slug }: { slug: string }) {
  const [path, setPath] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function generate() {
    if (!window.confirm('Gerar um link privado para este plano? Qualquer link BFCM anterior desta marca será revogado. Nada será enviado ao cliente.')) return
    setBusy(true); setMessage('')
    const result = await createBfcmAccessLink(slug)
    if (result.ok) { setPath(`${window.location.origin}${result.path}`); setMessage('Link privado gerado. Guarde-o: o CRM armazena apenas o hash. Nada foi enviado.') }
    else setMessage(result.error)
    setBusy(false)
  }
  async function revoke() {
    if (!window.confirm('Revogar o link privado deste plano? Quem estiver com ele perderá acesso.')) return
    setBusy(true)
    const result = await revokeBfcmAccessLink(slug)
    if (result.ok) { setPath(''); setMessage('Link revogado.') } else setMessage(result.error ?? 'Falha ao revogar.')
    setBusy(false)
  }
  return <details style={{ margin: '20px 32px 0', padding: 14, border: '1px solid var(--border)', borderRadius: 10, fontSize: 13 }}>
    <summary style={{ cursor: 'pointer' }}>Acesso privado do cliente · controle interno</summary>
    <p style={{ margin: '12px 0' }}>O link dá acesso somente a este plano. Não o publique. Gerar ou revogar não envia mensagens.</p>
    <button className="btn-secondary" disabled={busy} onClick={()=>void generate()}>Gerar / substituir link</button>{' '}
    <button className="btn-secondary" disabled={busy} onClick={()=>void revoke()}>Revogar link</button>
    {path && <label style={{ display: 'block', marginTop: 12 }}>Link privado <input aria-label="Link privado do cliente" readOnly value={path} onFocus={e=>e.target.select()} style={{ display: 'block', width: '100%', padding: 10 }} /></label>}
    {message && <p role="status" style={{ marginTop: 12 }}>{message}</p>}
  </details>
}
