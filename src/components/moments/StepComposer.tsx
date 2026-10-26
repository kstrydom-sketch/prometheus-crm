'use client'

import { useState, useTransition } from 'react'
import { addComment } from '@/lib/moments/actions'
import { COMMENT_KIND, type CommentKind } from '@/lib/moments/model'
import type { Person } from './StepControls'
import './moments.css'

// Internal comment box. The kind decides who gets told:
//   note → only @mentioned people · FYI → mentioned + followers, to read and
//   clear · needs action → stays in the tagged people's inbox until cleared.
export default function StepComposer({ momentId, stepId, people, defaultMention, parentId = null, onDone }: {
  momentId: string
  stepId: string | null
  people: Person[]
  defaultMention?: string | null
  /** Set when replying: the comment this reply belongs under. */
  parentId?: string | null
  onDone?: () => void
}) {
  const isReply = !!parentId
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<CommentKind>('note')
  const [mentions, setMentions] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const toggle = (id: string) => setMentions(m => (m.includes(id) ? m.filter(x => x !== id) : [...m, id]))
  const submit = () => {
    setError(null)
    start(async () => {
      const res = await addComment({ momentId, stepId, body, kind, mentions, parentId })
      if (!res.ok) { setError(res.error); return }
      setBody('')
      setMentions([])
      setKind('note')
      onDone?.()
    })
  }

  return (
    <div className={`mo-composer${isReply ? ' mo-composer-reply' : ''}`}>
      <label htmlFor={`composer-${parentId ?? stepId ?? momentId}`} style={{ marginBottom: 0 }}>{isReply ? 'Reply' : 'Internal comment'}</label>
      <textarea
        id={`composer-${parentId ?? stepId ?? momentId}`}
        value={body}
        autoFocus={isReply}
        onChange={e => setBody(e.target.value)}
        placeholder={isReply ? 'Reply to this thread…' : 'Only the team sees this.'}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit() }}
      />
      <div className="mo-seg" role="group" aria-label="Comment type">
        {(Object.keys(COMMENT_KIND) as CommentKind[]).map(k => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{COMMENT_KIND[k].label}</button>
        ))}
      </div>
      <span className="mo-muted" style={{ fontSize: 13 }}>{COMMENT_KIND[kind].hint}</span>
      <div>
        <span className="mo-muted" style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>Tag people</span>
        <div className="mo-chips">
          {people.map(p => (
            <button key={p.id} type="button" className="mo-chip" aria-pressed={mentions.includes(p.id)} onClick={() => toggle(p.id)}>
              {p.id === defaultMention ? `${p.name} (owner)` : p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="mo-row">
        <button type="button" className="btn-primary btn-sm" onClick={submit} disabled={pending || !body.trim()}>
          {pending ? 'Posting…' : isReply ? 'Post reply' : 'Post comment'}
        </button>
        {isReply && <button type="button" className="btn-secondary btn-sm" onClick={onDone}>Cancel</button>}
        {error && <span className="mo-error" role="alert">{error}</span>}
      </div>
    </div>
  )
}
