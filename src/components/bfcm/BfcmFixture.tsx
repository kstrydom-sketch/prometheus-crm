'use client'
import { useRef } from 'react'
import BfcmPlanner, { type SaveOperation } from './BfcmPlanner'
import { approveCopies, setCopyApproval, createDraft, lockDraft, reopenDraft, type Brand, type Draft } from '@/lib/bfcm/model'
const brand: Brand = { slug: 'example-brand', name: 'Example Brand · Fictional QA', cap: 100, aliases: [], contract: { kind: 'flexible' } }
const copies = Array.from({ length: 30 }, (_, i) => ({ id: `example-${i}`, text: `Example creative direction ${i + 1}. Replace this fictional test copy.`, source: 'Nova' as const }))
const draft = createDraft(brand, copies)
const refs = Array.from({ length: 20 }, (_, i) => ({ id: `sample-${i}`, title: `Fictional reference ${i + 1}`, category: ['grid','product-showcase','feature-callouts','reviews','split-screen'][i % 5], format: ['9:16','4:5','1:1','16:9','2:3'][i % 5], thumbnailUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400"><rect width="320" height="400" fill="#0f2233"/><text x="160" y="200" fill="#00e4e6" font-size="48" text-anchor="middle">${i+1}</text></svg>`)}`, videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' }))
export default function BfcmFixture() {
  const version = useRef(0)
  const state = useRef(draft)
  async function save(input: Draft, expected: number, operation: SaveOperation, copyId?: string) {
    await new Promise(resolve => setTimeout(resolve, 150))
    if (expected !== version.current) return { ok: false as const, error: 'Test save conflict.' }
    if (operation === 'apply-offers' || operation === 'regenerate-copy') return { ok: false as const, error: 'Fixture: AI is disabled. No external call was made.' }
    if (state.current.status === 'locked' && operation !== 'reopen') return { ok: false as const, error: 'Reopen this plan before editing.' }
    let next = operation === 'approve' ? approveCopies(state.current) : operation === 'lock' ? lockDraft(brand, state.current, true) : operation === 'reopen' ? reopenDraft(state.current, true) : input
    if (operation === 'approve-copy' || operation === 'unapprove-copy') {
      if (!copyId) return { ok: false as const, error: 'Select a copy line.' }
      next = setCopyApproval(state.current, copyId, operation === 'approve-copy')
    }
    if (operation === 'more-references') {
      const visible = state.current.visibleMotionIds ?? refs.slice(0, 10).map(ref => ref.id)
      const selected = state.current.motionIds
      const replacements = refs.filter(ref => !visible.includes(ref.id) && !selected.includes(ref.id)).map(ref => ref.id)
      if (selected.length >= 10 || replacements.length === 0) return { ok: false as const, error: 'No additional unchecked references are available.' }
      let cursor = 0
      const nextVisible = visible.map(id => selected.includes(id) ? id : replacements[cursor++] ?? id)
      next = { ...state.current, visibleMotionIds: nextVisible, revision: state.current.revision + 1 }
    }
    state.current = next
    return { ok: true as const, version: ++version.current, ...(operation !== 'save' ? { draft: next } : {}) }
  }
  return <><p style={{ padding: 12, background: '#fff2cd', color: '#533800', textAlign: 'center' }}>Fictional preview fixture · in-memory saves only · no client data · no Supabase/AI writes</p><BfcmPlanner brand={brand} initialDraft={draft} initialVersion={0} saveAction={save} motionReferences={refs} sourceNotice="Fictional QA data. All references use the same public test video." backHref="/offer-preview-qa/bfcm" /></>
}
