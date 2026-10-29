import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { ProductionStep } from './production'

const columns = 'id,plan_slug,sort_order,kind,title,owner_id,due_date,status'

/** Never throws: a missing table (migration not yet applied) must not break the plan page. */
export async function loadProductionSteps(slug: string): Promise<{ ok: true; steps: ProductionStep[] } | { ok: false }> {
  const { data, error } = await createServiceClient().from('bfcm_production_steps').select(columns).eq('plan_slug', slug).order('sort_order')
  return error ? { ok: false } : { ok: true, steps: (data ?? []) as ProductionStep[] }
}

export async function loadAllProductionSteps(): Promise<ProductionStep[]> {
  const { data, error } = await createServiceClient().from('bfcm_production_steps').select(columns)
  return error ? [] : (data ?? []) as ProductionStep[]
}
