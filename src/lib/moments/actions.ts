'use server'

// Moments & steps server actions. Every change is recorded by database
// triggers (activity_log), so these only write the change itself plus the
// inbox rows that tell people about it.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { canEdit } from '@/lib/permissions'
import {
  addWorkingDays, LAUNCH_DAY, monthLabel, STEP_TEMPLATE, TEMPLATE_GROUPS,
  type CommentKind, type MomentStatus, type StepStatus,
} from './model'

type Result = { ok: true } | { ok: false; error: string }

async function editor() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!(await canEdit(user.email))) return { ok: false as const, error: 'Not authorized.' }
  return { ok: true as const, supabase, user }
}

function refresh(momentId?: string) {
  revalidatePath('/moments')
  revalidatePath('/my-work')
  if (momentId) revalidatePath(`/moments/${momentId}`)
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function notify(
  supabase: Supabase,
  rows: Array<{ recipient_id: string; kind: 'needs_action' | 'fyi'; reason: string; title: string; body?: string | null; moment_id: string; step_id?: string | null; comment_id?: string | null }>,
  actorId: string,
) {
  // Never notify someone about their own action, and one row per person.
  const seen = new Set<string>()
  const list = rows.filter(r => {
    if (r.recipient_id === actorId || seen.has(r.recipient_id)) return false
    seen.add(r.recipient_id)
    return true
  }).map(r => ({ ...r, actor_id: actorId }))
  if (list.length) await supabase.from('inbox_items').insert(list)
}

async function follow(supabase: Supabase, momentId: string, profileId: string | null) {
  if (!profileId) return
  await supabase.from('moment_followers').upsert({ moment_id: momentId, profile_id: profileId }, { onConflict: 'moment_id,profile_id', ignoreDuplicates: true })
}

// ── create ─────────────────────────────────────────────────────────────────
export async function createMoment(formData: FormData): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth

  const brandId = String(formData.get('brand_id') ?? '')
  const month = String(formData.get('target_month') ?? '')          // YYYY-MM
  const slot = Number(formData.get('slot') ?? 1)
  const startDate = String(formData.get('start_date') ?? '')         // YYYY-MM-DD
  const ownerId = String(formData.get('owner_id') ?? '') || user.id
  if (!brandId || !/^\d{4}-\d{2}$/.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { ok: false, error: 'Pick a client, a month and a start date.' }
  }
  const targetMonth = `${month}-01`
  const { data: brand } = await supabase.from('brands').select('name').eq('id', brandId).single()
  if (!brand) return { ok: false, error: 'Unknown client.' }

  const { data: moment, error } = await supabase.from('moments').insert({
    brand_id: brandId, target_month: targetMonth, slot, start_date: startDate,
    launch_date: addWorkingDays(startDate, LAUNCH_DAY),
    name: `${brand.name} · ${monthLabel(targetMonth)} · M${slot}`,
    owner_id: ownerId, created_by: user.id,
  }).select('id').single()
  if (error || !moment) return { ok: false, error: `Could not create the moment: ${error?.message}` }

  const created = await insertTemplateSteps(supabase, moment.id, startDate)
  if (!created.ok) {
    // Don't leave a moment with no steps behind.
    await supabase.from('moments').delete().eq('id', moment.id)
    return created
  }
  await follow(supabase, moment.id, user.id)
  await follow(supabase, moment.id, ownerId)
  refresh()
  return { ok: true, id: moment.id }
}

async function insertTemplateSteps(supabase: Supabase, momentId: string, startDate: string): Promise<Result> {
  // Groups first, so children can point at them.
  // Every row lists every column: a bulk insert whose rows have different keys
  // sends NULL for the missing ones instead of using the column defaults.
  const row = (r: { id: string; parent_id: string | null; key: string; title: string; is_group: boolean; sort_order: number; due_date: string | null }) =>
    ({ moment_id: momentId, status: 'todo', ...r })
  const groupIds: Record<string, string> = {}
  let order = 0
  const top: Array<ReturnType<typeof row>> = []
  for (const t of STEP_TEMPLATE) {
    if (t.group && !groupIds[t.group]) {
      groupIds[t.group] = crypto.randomUUID()
      top.push(row({ id: groupIds[t.group], parent_id: null, key: t.group, title: TEMPLATE_GROUPS[t.group], is_group: true, sort_order: order++, due_date: null }))
    }
    if (!t.group) top.push(row({ id: crypto.randomUUID(), parent_id: null, key: t.key, title: t.title, is_group: false, sort_order: order++, due_date: addWorkingDays(startDate, t.day) }))
  }
  const children = STEP_TEMPLATE.filter(t => t.group).map((t, i) => row({
    id: crypto.randomUUID(), parent_id: groupIds[t.group!], key: t.key, title: t.title, is_group: false,
    sort_order: i, due_date: addWorkingDays(startDate, t.day),
  }))
  const { error: e1 } = await supabase.from('moment_steps').insert(top)
  if (e1) return { ok: false, error: `Could not add steps: ${e1.message}` }
  const { error: e2 } = await supabase.from('moment_steps').insert(children)
  if (e2) return { ok: false, error: `Could not add steps: ${e2.message}` }
  return { ok: true }
}

// ── steps ──────────────────────────────────────────────────────────────────
export async function updateStep(
  stepId: string,
  patch: { status?: StepStatus; assignee_id?: string | null; due_date?: string | null; title?: string },
): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth

  const { data: step } = await supabase.from('moment_steps').select('id, moment_id, title, assignee_id, moments(name)').eq('id', stepId).single()
  if (!step) return { ok: false, error: 'Step not found.' }
  const clean: Record<string, unknown> = {}
  if (patch.status) clean.status = patch.status
  if ('assignee_id' in patch) clean.assignee_id = patch.assignee_id || null
  if ('due_date' in patch) clean.due_date = patch.due_date || null
  if (patch.title !== undefined) {
    if (!patch.title.trim()) return { ok: false, error: 'A step needs a name.' }
    clean.title = patch.title.trim()
  }
  const { error } = await supabase.from('moment_steps').update(clean).eq('id', stepId)
  if (error) return { ok: false, error: error.message }

  const momentName = (step.moments as unknown as { name: string } | null)?.name ?? 'a moment'
  if (clean.assignee_id && clean.assignee_id !== step.assignee_id) {
    await notify(supabase, [{
      recipient_id: clean.assignee_id as string, kind: 'needs_action', reason: 'assigned',
      title: `You own “${step.title}”`, body: momentName, moment_id: step.moment_id, step_id: stepId,
    }], user.id)
    await follow(supabase, step.moment_id, clean.assignee_id as string)
  }
  refresh(step.moment_id)
  return { ok: true }
}

export async function addStep(momentId: string, parentId: string | null, title: string, dueDate: string | null): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase } = auth
  if (!title.trim()) return { ok: false, error: 'A step needs a name.' }
  let q = supabase.from('moment_steps').select('sort_order').eq('moment_id', momentId).order('sort_order', { ascending: false }).limit(1)
  q = parentId ? q.eq('parent_id', parentId) : q.is('parent_id', null)
  const { data: last } = await q.maybeSingle()
  const { error } = await supabase.from('moment_steps').insert({
    moment_id: momentId, parent_id: parentId, title: title.trim(), due_date: dueDate || null,
    sort_order: (last?.sort_order ?? -1) + 1,
  })
  if (error) return { ok: false, error: error.message }
  refresh(momentId)
  return { ok: true }
}

export async function deleteStep(stepId: string): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase } = auth
  const { data: step } = await supabase.from('moment_steps').select('moment_id').eq('id', stepId).single()
  const { error } = await supabase.from('moment_steps').delete().eq('id', stepId)
  if (error) return { ok: false, error: error.message }
  refresh(step?.moment_id)
  return { ok: true }
}

// ── moment ─────────────────────────────────────────────────────────────────
export async function updateMoment(
  momentId: string,
  patch: { owner_id?: string | null; launch_date?: string | null; status?: MomentStatus },
): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  const { error } = await supabase.from('moments').update(patch).eq('id', momentId)
  if (error) return { ok: false, error: error.message }
  if (patch.owner_id) {
    await follow(supabase, momentId, patch.owner_id)
    await notify(supabase, [{ recipient_id: patch.owner_id, kind: 'fyi', reason: 'assigned', title: 'You now own a moment', moment_id: momentId }], user.id)
  }
  refresh(momentId)
  return { ok: true }
}

/** Re-plan every open step from a new start date using the template's days. */
export async function rescheduleMoment(momentId: string, startDate: string): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase } = auth
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return { ok: false, error: 'Pick a start date.' }
  const { data: steps } = await supabase.from('moment_steps').select('id, key, status').eq('moment_id', momentId)
  const dayOf = Object.fromEntries(STEP_TEMPLATE.map(t => [t.key, t.day]))
  for (const s of steps ?? []) {
    if (!s.key || dayOf[s.key] === undefined || s.status === 'done' || s.status === 'skipped') continue
    await supabase.from('moment_steps').update({ due_date: addWorkingDays(startDate, dayOf[s.key]) }).eq('id', s.id)
  }
  await supabase.from('moments').update({ start_date: startDate, launch_date: addWorkingDays(startDate, LAUNCH_DAY) }).eq('id', momentId)
  refresh(momentId)
  return { ok: true }
}

export async function setFollowing(momentId: string, following: boolean): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  if (following) await follow(supabase, momentId, user.id)
  else await supabase.from('moment_followers').delete().eq('moment_id', momentId).eq('profile_id', user.id)
  refresh(momentId)
  return { ok: true }
}

// ── comments ───────────────────────────────────────────────────────────────
export async function addComment(input: {
  momentId: string
  stepId: string | null
  body: string
  kind: CommentKind
  mentions: string[]
  parentId?: string | null
}): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  const body = input.body.trim()
  if (!body) return { ok: false, error: 'Write something first.' }
  if (input.kind === 'needs_action' && !input.mentions.length) {
    return { ok: false, error: 'Tag who needs to act, so it lands in their inbox.' }
  }

  // Replies attach to the thread's first comment (one level deep), and everyone
  // already in the thread hears about them.
  let parentId: string | null = null
  let threadPeople: string[] = []
  if (input.parentId) {
    const { data: parent } = await supabase.from('step_comments').select('id, parent_id, moment_id, author_id').eq('id', input.parentId).single()
    if (!parent || parent.moment_id !== input.momentId) return { ok: false, error: 'That thread no longer exists.' }
    parentId = parent.parent_id ?? parent.id
    const { data: thread } = await supabase.from('step_comments').select('author_id, mentions').or(`id.eq.${parentId},parent_id.eq.${parentId}`)
    threadPeople = [...new Set((thread ?? []).flatMap(c => [c.author_id, ...(c.mentions ?? [])]).filter((x): x is string => !!x))]
  }

  const { data: comment, error } = await supabase.from('step_comments').insert({
    moment_id: input.momentId, step_id: input.stepId, author_id: user.id, body, kind: input.kind, mentions: input.mentions, parent_id: parentId,
  }).select('id').single()
  if (error || !comment) return { ok: false, error: error?.message ?? 'Could not post.' }

  const [{ data: step }, { data: moment }, { data: followers }] = await Promise.all([
    input.stepId ? supabase.from('moment_steps').select('title, assignee_id').eq('id', input.stepId).single() : Promise.resolve({ data: null }),
    supabase.from('moments').select('name').eq('id', input.momentId).single(),
    supabase.from('moment_followers').select('profile_id').eq('moment_id', input.momentId),
  ])
  const where = step ? `${step.title} · ${moment?.name ?? ''}` : moment?.name ?? ''
  const preview = body.length > 180 ? `${body.slice(0, 177)}…` : body
  const base = { moment_id: input.momentId, step_id: input.stepId, comment_id: comment.id, body: preview }

  // Order matters: notify() keeps the first row per person, so the strongest
  // reason wins (a mentioned follower gets the mention, not the FYI).
  const rows = [
    ...input.mentions.map(id => ({ ...base, recipient_id: id, kind: (input.kind === 'needs_action' ? 'needs_action' : 'fyi') as 'needs_action' | 'fyi', reason: 'mentioned', title: `${input.kind === 'needs_action' ? 'Action needed' : 'You were mentioned'}: ${where}` })),
    ...threadPeople.map(id => ({ ...base, recipient_id: id, kind: 'fyi' as const, reason: 'reply', title: `New reply: ${where}` })),
    ...(step?.assignee_id ? [{ ...base, recipient_id: step.assignee_id, kind: 'fyi' as const, reason: 'comment_on_my_step', title: `New comment on your step: ${where}` }] : []),
    ...(input.kind === 'note' ? [] : (followers ?? []).map(f => ({ ...base, recipient_id: f.profile_id, kind: 'fyi' as const, reason: 'following', title: `Update: ${where}` }))),
  ]
  await notify(supabase, rows, user.id)
  for (const id of input.mentions) await follow(supabase, input.momentId, id)
  await follow(supabase, input.momentId, user.id)
  refresh(input.momentId)
  return { ok: true }
}

// ── inbox ──────────────────────────────────────────────────────────────────
export async function clearInboxItem(id: string): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  const { error } = await supabase.from('inbox_items').update({ cleared_at: new Date().toISOString() }).eq('id', id).eq('recipient_id', user.id)
  if (error) return { ok: false, error: error.message }
  refresh()
  return { ok: true }
}

export async function clearAllFyi(): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  const { error } = await supabase.from('inbox_items').update({ cleared_at: new Date().toISOString() })
    .eq('recipient_id', user.id).eq('kind', 'fyi').is('cleared_at', null)
  if (error) return { ok: false, error: error.message }
  refresh()
  return { ok: true }
}
