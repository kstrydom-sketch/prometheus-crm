'use client'
import { useRef } from 'react'
import BfcmPlanner from './BfcmPlanner'
import { approveCopies, createDraft, lockDraft, reopenDraft, type Brand, type Draft } from '@/lib/bfcm/model'
const brand: Brand = { slug: 'example-brand', name: 'Example Brand · Fictional QA', cap: 100, aliases: [], contract: { kind: 'flexible' } }
const copies = Array.from({ length: 30 }, (_, i) => ({ id: `example-${i}`, text: `Example creative direction ${i + 1}. Replace this fictional test copy.`, source: 'Nova' as const }))
const draft = createDraft(brand, copies)
const refs = Array.from({ length: 10 }, (_, i) => ({ id: `sample-${i}`, title: `Fictional reference ${i + 1}`, category: ['grid','product-showcase','feature-callouts','reviews','split-screen'][i % 5], format: ['9:16','4:5','1:1','16:9','2:3'][i % 5], thumbnailUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400"><rect width="320" height="400" fill="#0f2233"/><text x="160" y="200" fill="#00e4e6" font-size="48" text-anchor="middle">${i+1}</text></svg>`)}`, videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' }))
export default function BfcmFixture() {
  const version = useRef(0)
  const state = useRef(draft)
  async function save(input: Draft, expected: number, operation: 'save'|'approve'|'lock'|'reopen'|'apply-offers') {
    await new Promise(resolve => setTimeout(resolve, 150))
    if (expected !== version.current) return { ok: false as const, error: 'Conflito de teste.' }
    if (operation === 'apply-offers') return { ok: false as const, error: 'Fixture: IA desativada. Nenhuma chamada externa foi feita.' }
    const next = operation === 'approve' ? approveCopies(state.current) : operation === 'lock' ? lockDraft(brand, state.current, true) : operation === 'reopen' ? reopenDraft(state.current, true) : input
    state.current = next
    return { ok: true as const, version: ++version.current, ...(operation !== 'save' ? { draft: next } : {}) }
  }
  return <><p style={{ padding: 12, background: '#fff2cd', color: '#533800', textAlign: 'center' }}>Fictional preview fixture · in-memory saves only · no client data · no Supabase/AI writes</p><BfcmPlanner brand={brand} initialDraft={draft} initialVersion={0} saveAction={save} motionReferences={refs} sourceNotice="Dados fictícios para QA. As dez referências usam o mesmo vídeo público de teste." backHref="/offer-preview-qa/bfcm" /></>
}
