'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { getCachedProfiles } from '@/lib/profiles'
import { requireBfcmEditor } from './server'
import { DEFAULT_STEPS, STEP_STATUSES } from './production'

type Result = { ok: true } | { ok: false; error: string }
const validSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id)

function done(slug: string): Result {
  revalidatePath('/bfcm-creatives')
  revalidatePath(`/bfcm-creatives/${slug}`)
  return { ok: true }
}

/** Adds any default step this plan doesn't have yet. Existing steps are left alone. */
export async function setupProductionSteps(slug: string): Promise<Result> {
  try {
    const user = await requireBfcmEditor()
    if (!validSlug(slug)) return { ok: false, error: 'Invalid plan.' }
    const rows = DEFAULT_STEPS.map(step => ({ ...step, plan_slug: slug, updated_by: user.id }))
    const { error } = await createServiceClient().from('bfcm_production_steps').upsert(rows, { onConflict: 'plan_slug,kind', ignoreDuplicates: true })
    return error ? { ok: false, error: 'Unable to add the steps.' } : done(slug)
  } catch { return { ok: false, error: 'Access is unauthorized or unavailable.' } }
}

export async function updateProductionStep(slug: string, id: string, patch: { owner_id?: string | null; due_date?: string | null; status?: string }): Promise<Result> {
  try {
    const user = await requireBfcmEditor()
    if (!validSlug(slug) || !validId(id)) return { ok: false, error: 'Invalid step.' }
    const update: Record<string, string | null> = {}
    if ('owner_id' in patch) {
      const owner = patch.owner_id ?? null
      if (owner !== null && !(await getCachedProfiles()).some(p => p.id === owner && p.can_edit)) return { ok: false, error: 'Unknown person.' }
      update.owner_id = owner
    }
    if ('due_date' in patch) {
      const due = patch.due_date || null
      if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: 'Invalid date.' }
      update.due_date = due
    }
    if ('status' in patch) {
      if (!STEP_STATUSES.some(s => s.id === patch.status)) return { ok: false, error: 'Invalid status.' }
      update.status = patch.status!
    }
    if (!Object.keys(update).length) return { ok: true }
    const { data, error } = await createServiceClient().from('bfcm_production_steps')
      .update({ ...update, updated_at: new Date().toISOString(), updated_by: user.id })
      .eq('id', id).eq('plan_slug', slug).select('id')
    if (error || !data?.length) return { ok: false, error: 'Unable to save. Reload and try again.' }
    return done(slug)
  } catch { return { ok: false, error: 'Access is unauthorized or unavailable.' } }
}

export async function deleteProductionStep(slug: string, id: string): Promise<Result> {
  try {
    await requireBfcmEditor()
    if (!validSlug(slug) || !validId(id)) return { ok: false, error: 'Invalid step.' }
    const { error } = await createServiceClient().from('bfcm_production_steps').delete().eq('id', id).eq('plan_slug', slug)
    return error ? { ok: false, error: 'Unable to remove the step.' } : done(slug)
  } catch { return { ok: false, error: 'Access is unauthorized or unavailable.' } }
}
