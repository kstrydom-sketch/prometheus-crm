'use server'

import { createHash, randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { validateOffers, approveCopies, lockDraft, reopenDraft, updateDraft, parseStoredDraft, type Draft, type DraftPatch } from './model'
import { loadPlan, requireBfcmEditor, resolveClientPlan } from './server'

type Operation = 'save' | 'approve' | 'lock' | 'reopen' | 'apply-offers'
type Result = { ok: true; version: number; draft?: Draft } | { ok: false; error: string }
const editable = ['offers', 'prePercent', 'allocation', 'allocationLocks', 'copies', 'motionIds', 'voiceover', 'sfx'] as const

async function persist(slug: string, input: Draft, expectedVersion: number, operation: Operation): Promise<Result> {
  if (!['save', 'approve', 'lock', 'reopen', 'apply-offers'].includes(operation) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return { ok: false, error: 'Solicitação inválida.' }
  // Runtime validation is required: exported server actions are public POST endpoints.
  const raw = JSON.stringify(input)
  if (raw.length > 240_000) return { ok: false, error: 'Plano muito grande. Reduza o texto antes de salvar.' }
  const candidate = parseStoredDraft(raw, slug)
  if (!candidate) return { ok: false, error: 'Dados inválidos. Recarregue o plano.' }
  const client = createServiceClient()
  const { row, brand, config, draft: current } = await loadPlan(slug, client)
  if (row.version !== expectedVersion) return { ok: false, error: 'Este plano foi alterado em outra sessão. Recarregue antes de continuar; suas alterações não foram sobrescritas.' }
  const allowedRefs = new Set(config.motionReferences.map(ref => ref.id))
  if (candidate.motionIds.length > 10 || candidate.motionIds.some(id => !allowedRefs.has(id))) return { ok: false, error: 'Referência de motion inválida para esta marca.' }
  if (candidate.copies.some((copy, i) => copy.id !== current.copies[i].id || copy.source !== current.copies[i].source)) return { ok: false, error: 'A origem das copies não pode ser alterada.' }
  const patch: DraftPatch = {}
  for (const key of editable) {
    if (JSON.stringify(candidate[key]) !== JSON.stringify(current[key])) Object.assign(patch, { [key]: candidate[key] })
  }
  let next = current
  if (operation === 'save') {
    if (current.status === 'locked') return { ok: false, error: 'Reabra explicitamente o plano antes de editar.' }
    if (!Object.keys(patch).length) return { ok: true, version: row.version }
    // Approval/revision/history/status are always derived from the persisted state.
    next = updateDraft({ ...current, allocationLocks: candidate.allocationLocks }, patch)
  } else {
    if (Object.keys(patch).length) return { ok: false, error: 'Aguarde o salvamento das alterações antes de confirmar.' }
    if (operation === 'apply-offers') {
      if (current.status === 'locked') return { ok: false, error: 'Reabra o plano antes de gerar copies.' }
      const errors = validateOffers(current.offers)
      if (errors.length) return { ok: false, error: errors.join(' ') }
      const { generateBfcmCopies } = await import('./generate')
      // Keep the existing hypercare restriction, including the actual linked brand name.
      let linkedName: string | null = null
      if (row.brand_id) {
        const { data: linked, error: linkedError } = await client.from('brands').select('name').eq('id', row.brand_id).single()
        if (linkedError || !linked) return { ok: false, error: 'Não foi possível verificar as restrições da marca.' }
        linkedName = linked.name
      }
      const { data: claimed, error: claimError } = await client.rpc('bfcm_claim_generation', { p_slug: slug, p_expected_version: row.version })
      if (claimError || claimed !== true) return { ok: false, error: 'Aguarde 60 segundos entre gerações ou recarregue se o plano mudou.' }
      const copies = await generateBfcmCopies(brand, current, linkedName, config.websiteFacts)
      next = updateDraft(current, { copies })
    }
    if (operation === 'approve') next = approveCopies(current)
    if (operation === 'lock') next = lockDraft(brand, current, true)
    if (operation === 'reopen') next = reopenDraft(current, true)
  }
  // History is append-only in its own table, atomically recorded by the RPC.
  const state = { ...next, history: undefined }
  const { data: version, error } = await client.rpc('bfcm_save_plan', { p_slug: slug, p_state: state, p_expected_version: expectedVersion })
  if (error || typeof version !== 'number') {
    return { ok: false, error: error?.message.includes('BFCM_CONFLICT') ? 'Este plano foi alterado em outra sessão. Recarregue para continuar.' : 'Não foi possível salvar. Seu plano não foi confirmado. Tente novamente.' }
  }
  revalidatePath('/bfcm-creatives')
  if (operation !== 'save') {
    const saved = await loadPlan(slug, client)
    return { ok: true, version, draft: saved.draft }
  }
  return { ok: true, version }
}

export async function saveStaffBfcmPlan(slug: string, draft: Draft, expectedVersion: number, operation: Operation = 'save'): Promise<Result> {
  try {
    await requireBfcmEditor()
    return await persist(slug, draft, expectedVersion, operation)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Não foi possível salvar o plano.' }
  }
}
export async function saveClientBfcmPlan(token: string, draft: Draft, expectedVersion: number, operation: Operation = 'save'): Promise<Result> {
  try {
    const resolved = await resolveClientPlan(token)
    if (!resolved) return { ok: false, error: 'Link inválido ou indisponível.' }
    // slug is derived solely from verified module token → plan. Never draft.brandSlug.
    return await persist(resolved.slug, draft, expectedVersion, operation)
  } catch {
    return { ok: false, error: 'Não foi possível salvar. Tente novamente ou fale com a equipe.' }
  }
}

/** Explicit staff-only capability rotation. This does not send any client message. */
export async function createBfcmAccessLink(slug: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    await requireBfcmEditor()
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return { ok: false, error: 'Plano inválido.' }
    const token = randomBytes(32).toString('hex')
    const digest = createHash('sha256').update(token).digest('hex')
    const { data, error } = await createServiceClient().from('bfcm_plans').update({ access_token_hash: digest }).eq('slug', slug).select('slug').single()
    if (error || !data) return { ok: false, error: 'Não foi possível gerar o link.' }
    return { ok: true, path: `/portal/bfcm/${token}` }
  } catch { return { ok: false, error: 'Acesso não autorizado ou indisponível.' } }
}
export async function revokeBfcmAccessLink(slug: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await requireBfcmEditor()
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return { ok: false, error: 'Plano inválido.' }
    const { error } = await createServiceClient().from('bfcm_plans').update({ access_token_hash: null }).eq('slug', slug)
    return error ? { ok: false, error: 'Não foi possível revogar o link.' } : { ok: true }
  } catch { return { ok: false, error: 'Acesso não autorizado ou indisponível.' } }
}
