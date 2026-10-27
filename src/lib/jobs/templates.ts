'use server'

// Workflow template actions. Management only (canEditTemplates). Jobs copy a
// template when they're created, so saving here never changes running jobs.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { canEditTemplates } from '@/lib/permissions'
import { getCachedProfiles } from '@/lib/profiles'
import type { TemplateStage, TemplateStep } from './model'

type Result = { ok: true; id: string } | { ok: false; error: string }

export interface TemplateInput {
  name: string
  description: string
  uses_month_slot: boolean
  done_label: string
  due_label: string
  stages: TemplateStage[]
  steps: TemplateStep[]
}

async function manager() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!canEditTemplates(user.email)) return { ok: false as const, error: 'Only management can change workflows.' }
  const me = (await getCachedProfiles()).find(p => p.email.toLowerCase() === user.email?.toLowerCase())
  return { ok: true as const, supabase, meId: me?.id ?? null }
}

function clean(input: TemplateInput): { ok: true; row: TemplateInput } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the workflow a name.' }
  const stages = input.stages.map(s => ({ key: s.key, label: s.label.trim() })).filter(s => s.label)
  const labels = stages.map(s => s.label.toLowerCase())
  if (new Set(labels).size !== labels.length) return { ok: false, error: 'Two stages have the same name.' }
  if (new Set(stages.map(s => s.key)).size !== stages.length) return { ok: false, error: 'Two stages share a key. Remove one and add it again.' }
  const stageKeys = new Set(stages.map(s => s.key))
  const steps: TemplateStep[] = []
  for (const s of input.steps) {
    const title = s.title.trim()
    if (!title) continue
    if (!Number.isInteger(s.day) || s.day < 0 || s.day > 365) return { ok: false, error: `“${title}”: the day must be a whole number from 0 to 365.` }
    steps.push({ key: s.key, title, day: s.day, group: s.group?.trim() || null, stage: s.stage && stageKeys.has(s.stage) ? s.stage : null })
  }
  if (!steps.length) return { ok: false, error: 'Add at least one step.' }
  if (new Set(steps.map(s => s.key)).size !== steps.length) return { ok: false, error: 'Two steps share a key. Remove one and add it again.' }
  if (stages.length && steps.some(s => !s.stage)) return { ok: false, error: 'Every step needs a stage, so the job’s stage stays accurate.' }
  return {
    ok: true,
    row: {
      name, description: input.description.trim(), uses_month_slot: !!input.uses_month_slot,
      done_label: input.done_label.trim() || 'Done', due_label: input.due_label.trim() || 'Due', stages, steps,
    },
  }
}

export async function saveTemplate(id: string | null, input: TemplateInput): Promise<Result> {
  const auth = await manager()
  if (!auth.ok) return auth
  const { supabase, meId } = auth
  const c = clean(input)
  if (!c.ok) return c
  const row = { ...c.row, description: c.row.description || null, updated_by: meId }
  let res
  if (id) {
    res = await supabase.from('workflow_templates').update(row).eq('id', id).select('id').single()
  } else {
    // New workflows go to the end of the list.
    const { data: last } = await supabase.from('workflow_templates').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
    res = await supabase.from('workflow_templates').insert({ ...row, sort_order: (last?.sort_order ?? -1) + 1, created_by: meId }).select('id').single()
  }
  if (res.error || !res.data) {
    return { ok: false, error: res.error?.code === '23505' ? 'A workflow with that name already exists.' : `Could not save: ${res.error?.message}` }
  }
  revalidatePath('/jobs', 'layout')
  return { ok: true, id: res.data.id }
}

/** Archived workflows can't be picked for new jobs; jobs already made from them carry on. */
export async function setTemplateArchived(id: string, archived: boolean): Promise<Result> {
  const auth = await manager()
  if (!auth.ok) return auth
  const { error } = await auth.supabase.from('workflow_templates')
    .update({ archived_at: archived ? new Date().toISOString() : null, updated_by: auth.meId }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/jobs', 'layout')
  return { ok: true, id }
}
