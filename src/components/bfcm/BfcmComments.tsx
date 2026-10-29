'use client'
import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Avatar from '@/components/Avatar'
import type { Person } from '@/lib/bfcm/production'
import type { BfcmComment } from '@/lib/bfcm/production-server'
import { addComment, deleteComment } from '@/lib/bfcm/production-actions'
import s from './BfcmProduction.module.css'

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Highlights @Name for anyone on the team; longest names first so "Ana Lu" wins over "Ana". */
function withMentions(body: string, people: Person[]) {
  const names = people.map(p => p.name).sort((a, b) => b.length - a.length)
  if (!names.length) return body
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return body.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g')).map((part, i) => part.startsWith('@') && names.includes(part.slice(1)) ? <span key={i} className={s.mention}>{part}</span> : part)
}

/** Internal comments on one task (stepId) or on the whole brand (stepId null). Staff only. */
export default function BfcmComments({ slug, stepId, comments, people, meId, placeholder }: { slug: string; stepId: string | null; comments: BfcmComment[]; people: Person[]; meId: string | null; placeholder: string }) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const matches = useMemo(() => query === null ? [] : people.filter(p => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6), [query, people])

  function track(value: string, caret: number) {
    const before = value.slice(0, caret)
    const at = before.lastIndexOf('@')
    const token = at >= 0 && (at === 0 || /\s/.test(before[at - 1])) ? before.slice(at + 1) : null
    setQuery(token !== null && !/\n/.test(token) && token.length <= 30 ? token : null)
    setActive(0)
  }
  function pick(person: Person) {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart ?? text.length
    const at = text.slice(0, caret).lastIndexOf('@')
    const next = `${text.slice(0, at)}@${person.name} ${text.slice(caret)}`
    setText(next); setQuery(null)
    requestAnimationFrame(() => { el.focus(); const pos = at + person.name.length + 2; el.setSelectionRange(pos, pos) })
  }
  async function post() {
    if (!text.trim() || busy) return
    setBusy(true); setError('')
    const result = await addComment(slug, stepId, text)
    if (result.ok) { setText(''); router.refresh() } else setError(result.error)
    setBusy(false)
  }
  async function remove(id: string) {
    if (!window.confirm('Remove this comment?')) return
    const result = await deleteComment(slug, id)
    if (result.ok) router.refresh(); else setError(result.error)
  }

  return <div className={s.thread}>
    {comments.map(c => <div key={c.id} className={s.comment}>
      <Avatar name={c.author_name} size={26} />
      <div>
        <div className={s.commentHead}><strong>{c.author_name}</strong><span className={s.faint}>{when(c.created_at)}</span>{meId && c.author_id === meId && <button className={s.linkBtn} onClick={() => void remove(c.id)}>Remove</button>}</div>
        <p className={s.commentBody}>{withMentions(c.body, people)}</p>
      </div>
    </div>)}
    <div className={s.composer}>
      {matches.length > 0 && <div className={s.suggest} role="listbox">{matches.map((p, i) => <button key={p.id} type="button" role="option" aria-selected={i === active} className={s.option} style={i === active ? { background: 'var(--surface-raised)' } : undefined} onMouseDown={e => { e.preventDefault(); pick(p) }}><Avatar name={p.name} size={20} />{p.name}</button>)}</div>}
      <textarea ref={ref} className={s.textarea} rows={1} value={text} placeholder={placeholder} aria-label={placeholder} disabled={busy}
        onChange={e => { setText(e.target.value); track(e.target.value, e.target.selectionStart ?? e.target.value.length) }}
        onKeyDown={e => {
          if (matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % matches.length); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + matches.length) % matches.length); return }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]); return }
            if (e.key === 'Escape') { setQuery(null); return }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void post() }
        }} />
      <button className="btn-primary btn-sm" disabled={busy || !text.trim()} onClick={() => void post()}>{busy ? 'Posting…' : 'Post'}</button>
    </div>
    {error && <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
  </div>
}
