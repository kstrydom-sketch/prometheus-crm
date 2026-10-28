import 'server-only'
import { createHash } from 'node:crypto'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canEdit } from '@/lib/permissions'
import { createDraft, parseStoredDraft, type Draft, type PlanSnapshot } from './model'
import { parsePlanConfig } from './content'

export type PlanRow = { slug: string; brand_id: string | null; state: unknown; config: unknown; version: number; updated_at: string }
export async function requireBfcmEditor() {
  const user = await getCachedUser()
  if (!user || !await canEdit(user.email)) throw new Error('Acesso não autorizado.')
  return user
}
export async function loadPlan(slug: string, client = createServiceClient()) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw new Error('Plano não encontrado.')
  const { data, error } = await client.from('bfcm_plans').select('slug,brand_id,state,config,version,updated_at').eq('slug', slug).single()
  if (error || !data) throw new Error('O módulo BFCM ainda não está disponível. Nenhuma alteração foi salva.')
  const row = data as PlanRow
  const config = parsePlanConfig(row.config, slug)
  if (!config) throw new Error('Configuração privada do plano indisponível.')
  const brand = config.brand
  const { data: versions, error: versionsError } = await client.from('bfcm_plan_versions').select('version,snapshot,locked_at').eq('plan_slug', slug).order('version', { ascending: true })
  if (versionsError) throw new Error('Não foi possível carregar o histórico BFCM.')
  const history = (versions ?? []).map((v, i) => ({ version: i + 1, lockedAt: v.locked_at as string, snapshot: v.snapshot as PlanSnapshot }))
  const draft = row.state === null ? createDraft(brand, config.initialCopies) : parseStoredDraft(JSON.stringify({ ...(row.state as object), history }), slug)
  if (!draft) throw new Error('Plano inválido. Entre em contato com a equipe antes de continuar.')
  return { row, brand, config, draft: draft as Draft }
}
export async function resolveClientPlan(token: string) {
  // Module-only capability. Raw tokens are never persisted or logged.
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const client = createServiceClient()
  const digest = createHash('sha256').update(token).digest('hex')
  const { data: plan, error } = await client.from('bfcm_plans').select('slug').eq('access_token_hash', digest).single()
  if (error || !plan) return null
  return { slug: plan.slug as string, client }
}

export async function listStaffPlans() {
  await requireBfcmEditor()
  const client = await createClient()
  const { data, error } = await client.from('bfcm_plans').select('slug,brand_id,state,config,version,updated_at')
  return { plans: (data ?? []) as PlanRow[], unavailable: !!error }
}
