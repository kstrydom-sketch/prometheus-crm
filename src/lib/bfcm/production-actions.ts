'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotifications } from '@/lib/notifications'
import { loadPlan } from './server'
import { ensureCalibrationSubtasks, loadPeople, requireStaffProfile } from './production-server'
import { DEFAULT_STEPS, isStepStatus, mentionedIds, planKeyCount, planSplitFor } from './production'

type Result = { ok: true } | { ok: false; error: string }
const validSlug = (slug: string) => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const cleanTitle = (title: unknown) => typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''

function done(slug: string): Result {
  revalidatePath('/bfcm-creatives')
  revalidatePath(`/bfcm-creatives/${slug}`)
  return { ok: true }
}
/** Every action: an editor, a valid plan, and a readable error instead of a thrown one. */
async function run(slug: string, body: (me: { id: string | null; name: string }) => Promise<Result>): Promise<Result> {
  try {
    const me = await requireStaffProfile()
    if (!validSlug(slug)) return { ok: false, error: 'Invalid plan.' }
    return await body(me)
  } catch (error) {
    console.error('[bfcm production]', error)
    return { ok: false, error: error instanceof Error && error.message === 'Unauthorized access.' ? 'You need CRM access to do that.' : 'Something went wrong. Reload and try again.' }
  }
}
async function stepOf(slug: string, id: string) {
  const { data } = await createServiceClient().from('bfcm_production_steps').select('id,kind,parent_id,title,plan_key,made_count').eq('id', id).eq('plan_slug', slug).maybeSingle()
  return data as { id: string; kind: string; parent_id: string | null; title: string; plan_key: string | null; made_count: number } | null
}
/** The change to log; nothing when the count didn't move. */
async function logMade(slug: string, stepId: string, delta: number, by: string | null) {
  if (delta) await createServiceClient().from('bfcm_made_log').insert({ plan_slug: slug, step_id: stepId, delta, created_by: by })
}
async function planContext(slug: string) {
  const { data } = await createServiceClient().from('bfcm_plans').select('brand_id,config').eq('slug', slug).maybeSingle()
  const brandName = (data?.config as { brand?: { name?: string } } | null)?.brand?.name ?? slug
  return { brandId: (data?.brand_id as string | null) ?? null, brandName }
}
async function nextSortOrder(slug: string, parentId: string | null) {
  const db = createServiceClient()
  const query = db.from('bfcm_production_steps').select('sort_order').eq('plan_slug', slug).order('sort_order', { ascending: false }).limit(1)
  const { data } = await (parentId ? query.eq('parent_id', parentId) : query.is('parent_id', null))
  return ((data?.[0]?.sort_order as number | undefined) ?? 0) + 1
}

/** Adds any default task this brand doesn't have yet. Existing tasks are left alone. */
export async function setupProductionSteps(slug: string): Promise<Result> {
  return run(slug, async me => {
    const db = createServiceClient()
    const { data, error } = await db.from('bfcm_production_steps').select('kind').eq('plan_slug', slug).is('parent_id', null)
    if (error) return { ok: false, error: 'Unable to add the tasks.' }
    const have = new Set((data ?? []).map(r => r.kind))
    const rows = DEFAULT_STEPS.filter(s => !have.has(s.kind)).map(s => ({ ...s, plan_slug: slug, updated_by: me.id }))
    if (rows.length && (await db.from('bfcm_production_steps').insert(rows)).error) return { ok: false, error: 'Unable to add the tasks.' }
    await ensureCalibrationSubtasks(slug)
    return done(slug)
  })
}

export async function addTask(slug: string, parentId: string | null, title: string): Promise<Result> {
  return run(slug, async me => {
    const clean = cleanTitle(title)
    if (!clean || clean.length > 120) return { ok: false, error: 'Give the task a name (up to 120 characters).' }
    if (parentId !== null) {
      const parent = validId(parentId) ? await stepOf(slug, parentId) : null
      if (!parent) return { ok: false, error: 'That task no longer exists.' }
      if (parent.parent_id) return { ok: false, error: 'Subtasks can’t have their own subtasks.' }
    }
    const { error } = await createServiceClient().from('bfcm_production_steps').insert({
      plan_slug: slug, parent_id: parentId, kind: 'task', title: clean, sort_order: await nextSortOrder(slug, parentId), updated_by: me.id,
    })
    return error ? { ok: false, error: 'Unable to add the task.' } : done(slug)
  })
}

/** Makes one subtask per category and phase from the plan's split. Re-running only adds what's missing. */
export async function splitTaskByPlan(slug: string, stepId: string): Promise<Result> {
  return run(slug, async me => {
    const step = validId(stepId) ? await stepOf(slug, stepId) : null
    if (!step || step.parent_id) return { ok: false, error: 'That task no longer exists.' }
    const { draft } = await loadPlan(slug)
    const split = planSplitFor(step.kind, draft)
    if (!split.length) return { ok: false, error: 'The plan has nothing to split for this task yet.' }
    const db = createServiceClient()
    const { data } = await db.from('bfcm_production_steps').select('plan_key').eq('parent_id', step.id)
    const have = new Set((data ?? []).map(r => r.plan_key))
    let order = await nextSortOrder(slug, step.id)
    const rows = split.filter(s => !have.has(s.plan_key)).map(s => ({ plan_slug: slug, parent_id: step.id, kind: 'task', title: s.title, plan_key: s.plan_key, sort_order: order++, updated_by: me.id }))
    if (rows.length && (await db.from('bfcm_production_steps').insert(rows)).error) return { ok: false, error: 'Unable to split the task.' }
    return done(slug)
  })
}

export async function updateTask(slug: string, id: string, patch: { title?: string; due_date?: string | null; status?: string }): Promise<Result> {
  return run(slug, async me => {
    const step = validId(id) ? await stepOf(slug, id) : null
    if (!step) return { ok: false, error: 'That task no longer exists.' }
    const db = createServiceClient()
    const update: Record<string, string | number | null> = {}
    if ('title' in patch) {
      const clean = cleanTitle(patch.title)
      if (!clean || clean.length > 120) return { ok: false, error: 'Give the task a name (up to 120 characters).' }
      update.title = clean
    }
    if ('due_date' in patch) {
      const due = patch.due_date || null
      if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: 'Invalid date.' }
      update.due_date = due
    }
    if ('status' in patch) {
      if (!isStepStatus(patch.status)) return { ok: false, error: 'Invalid status.' }
      const { count } = await db.from('bfcm_production_steps').select('id', { count: 'exact', head: true }).eq('parent_id', step.id)
      if (count) return { ok: false, error: 'This task’s status follows its subtasks.' }
      update.status = patch.status
      // Done means all of them are made, so the count and the pace stay true.
      if (patch.status === 'done' && step.plan_key) update.made_count = planKeyCount(step.plan_key, (await loadPlan(slug)).draft) ?? step.made_count
    }
    if (!Object.keys(update).length) return { ok: true }
    const { error } = await db.from('bfcm_production_steps').update({ ...update, updated_at: new Date().toISOString(), updated_by: me.id }).eq('id', step.id)
    if (error) return { ok: false, error: 'Unable to save. Reload and try again.' }
    if (typeof update.made_count === 'number') await logMade(slug, step.id, update.made_count - step.made_count, me.id)
    return done(slug)
  })
}

/** How many of a plan-linked subtask's creatives are made. Moves the status along with it. */
export async function setMadeCount(slug: string, id: string, made: number): Promise<Result> {
  return run(slug, async me => {
    const step = validId(id) ? await stepOf(slug, id) : null
    if (!step?.plan_key) return { ok: false, error: 'That task no longer exists.' }
    const full = planKeyCount(step.plan_key, (await loadPlan(slug)).draft) ?? 0
    if (!Number.isSafeInteger(made) || made < 0 || made > full) return { ok: false, error: `Enter a whole number from 0 to ${full}.` }
    const db = createServiceClient()
    const { data: current } = await db.from('bfcm_production_steps').select('status').eq('id', step.id).maybeSingle()
    const status = made === full && full > 0 ? 'done' : made > 0 && (current?.status === 'todo' || current?.status === 'done') ? 'in_progress' : made === 0 && current?.status === 'done' ? 'todo' : current?.status
    const { error } = await db.from('bfcm_production_steps').update({ made_count: made, status, updated_at: new Date().toISOString(), updated_by: me.id }).eq('id', step.id)
    if (error) return { ok: false, error: 'Unable to save. Reload and try again.' }
    await logMade(slug, step.id, made - step.made_count, me.id)
    return done(slug)
  })
}

/** Sets the full list of people on a task. Newly added people get a notification. */
export async function setTaskAssignees(slug: string, id: string, profileIds: string[]): Promise<Result> {
  return run(slug, async me => {
    const step = validId(id) ? await stepOf(slug, id) : null
    if (!step) return { ok: false, error: 'That task no longer exists.' }
    if (!Array.isArray(profileIds) || profileIds.length > 20 || !profileIds.every(validId)) return { ok: false, error: 'Invalid people.' }
    const people = await loadPeople()
    const wanted = [...new Set(profileIds)]
    if (wanted.some(pid => !people.some(p => p.id === pid))) return { ok: false, error: 'Unknown person.' }
    const db = createServiceClient()
    const { data: current, error } = await db.from('bfcm_step_assignees').select('profile_id').eq('step_id', step.id)
    if (error) return { ok: false, error: 'Unable to save. Reload and try again.' }
    const had = new Set((current ?? []).map(r => r.profile_id as string))
    const added = wanted.filter(pid => !had.has(pid))
    const removed = [...had].filter(pid => !wanted.includes(pid))
    if (added.length && (await db.from('bfcm_step_assignees').insert(added.map(profile_id => ({ step_id: step.id, profile_id })))).error) return { ok: false, error: 'Unable to save. Reload and try again.' }
    if (removed.length && (await db.from('bfcm_step_assignees').delete().eq('step_id', step.id).in('profile_id', removed)).error) return { ok: false, error: 'Unable to save. Reload and try again.' }
    const recipients = added.filter(pid => pid !== me.id)
    if (recipients.length) {
      const { brandId, brandName } = await planContext(slug)
      await createNotifications(recipients.map(recipient_id => ({
        recipient_id, actor_id: me.id, actor_label: me.name, type: 'assigned' as const, brand_id: brandId,
        title: `${me.name} assigned you to a BFCM task`, body: `${brandName}: ${step.title}`, link: `/bfcm-creatives/${slug}#task-${step.id}`,
      })))
    }
    return done(slug)
  })
}

export async function deleteTask(slug: string, id: string): Promise<Result> {
  return run(slug, async () => {
    const step = validId(id) ? await stepOf(slug, id) : null
    if (!step) return done(slug)
    const { error } = await createServiceClient().from('bfcm_production_steps').delete().eq('id', step.id)
    return error ? { ok: false, error: 'Unable to remove the task.' } : done(slug)
  })
}

/** Internal comment on a task, or on the whole brand when stepId is null. @mentions notify. */
export async function addComment(slug: string, stepId: string | null, body: string): Promise<Result> {
  return run(slug, async me => {
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text || text.length > 5000) return { ok: false, error: 'Write a comment (up to 5,000 characters).' }
    const step = stepId === null ? null : validId(stepId) ? await stepOf(slug, stepId) : null
    if (stepId !== null && !step) return { ok: false, error: 'That task no longer exists.' }
    const { data, error } = await createServiceClient().from('bfcm_comments')
      .insert({ plan_slug: slug, step_id: step?.id ?? null, author_id: me.id, author_name: me.name, body: text }).select('id').single()
    if (error) return { ok: false, error: 'Unable to post the comment.' }
    const recipients = mentionedIds(text, await loadPeople()).filter(pid => pid !== me.id)
    if (recipients.length) {
      const { brandId, brandName } = await planContext(slug)
      await createNotifications(recipients.map(recipient_id => ({
        recipient_id, actor_id: me.id, actor_label: me.name, type: 'mentioned' as const, brand_id: brandId, comment_id: data.id,
        title: `${me.name} mentioned you`, body: `${brandName}${step ? ` · ${step.title}` : ''}: ${text.slice(0, 140)}`,
        link: `/bfcm-creatives/${slug}${step ? `#task-${step.id}` : '#team-thread'}`,
      })))
    }
    return done(slug)
  })
}

/** Only the author can remove their own comment. */
export async function deleteComment(slug: string, id: string): Promise<Result> {
  return run(slug, async me => {
    if (!validId(id) || !me.id) return { ok: false, error: 'Invalid comment.' }
    const { data, error } = await createServiceClient().from('bfcm_comments').delete().eq('id', id).eq('plan_slug', slug).eq('author_id', me.id).select('id')
    if (error) return { ok: false, error: 'Unable to remove the comment.' }
    return data?.length ? done(slug) : { ok: false, error: 'You can only remove your own comments.' }
  })
}
