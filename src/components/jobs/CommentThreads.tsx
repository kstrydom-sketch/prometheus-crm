'use client'

import { useState } from 'react'
import type { StepComment } from '@/lib/jobs/model'
import StepComposer from './StepComposer'
import type { Person } from './StepControls'
import './jobs.css'

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
const KIND_LABEL = { needs_action: 'Needs action', fyi: 'FYI', note: 'Note' } as const

function Comment({ c, nameOf }: { c: StepComment; nameOf: (id: string | null) => string }) {
  return (
    <article className="mo-comment">
      <div className="mo-comment-head">
        <b>{nameOf(c.author_id)}</b>
        <span className={`mo-kind mo-kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
        <span className="mo-muted" style={{ fontSize: 13 }} suppressHydrationWarning>{when(c.created_at)}</span>
      </div>
      <div className="mo-comment-body">{c.body}</div>
      {c.mentions.length > 0 && <div className="mo-muted" style={{ fontSize: 13 }}>Tagged: {c.mentions.map(nameOf).join(', ')}</div>}
    </article>
  )
}

// Top-level comments in order, each followed by its replies. Replies always
// hang off the first comment of a thread, so there is only one level.
export default function CommentThreads({ comments, people, jobId, stepId, emptyText }: {
  comments: StepComment[]
  people: Person[]
  jobId: string
  stepId: string | null
  emptyText: string
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const nameOf = (id: string | null) => (id ? people.find(p => p.id === id)?.name ?? 'Someone' : 'Someone')
  const roots = comments.filter(c => !c.parent_id)
  const repliesOf = (id: string) => comments.filter(c => c.parent_id === id)

  if (!roots.length) return <p className="mo-muted" style={{ margin: 0, fontSize: 14 }}>{emptyText}</p>
  return (
    <div className="mo-thread">
      {roots.map(root => {
        const replies = repliesOf(root.id)
        return (
          <div key={root.id} className="mo-threadgroup">
            <Comment c={root} nameOf={nameOf} />
            {replies.length > 0 && (
              <div className="mo-replies">
                {replies.map(r => <Comment key={r.id} c={r} nameOf={nameOf} />)}
              </div>
            )}
            {replyingTo === root.id ? (
              <div className="mo-replies">
                <StepComposer jobId={jobId} stepId={stepId} people={people} parentId={root.id} onDone={() => setReplyingTo(null)} />
              </div>
            ) : (
              <button type="button" className="mo-reply-btn" onClick={() => setReplyingTo(root.id)}>
                Reply{replies.length ? ` · ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : ''}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
