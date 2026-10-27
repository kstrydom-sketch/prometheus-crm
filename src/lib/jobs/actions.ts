'use server'

// Jobs & steps server actions. Every change is recorded by database triggers
// (activity_log), so these only write the change itself plus the inbox rows
// that tell people about it.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { canEdit } from '@/lib/permissions'
import {
  addWorkingDays, isOpen, monthLabel, templateLength,
  type CommentKind, type JobStatus, type StepStatus, type WorkflowTemplate,
} from './model'
import { isLinkedStep } from './review'

type Result = { ok: true } | { ok: false; error: string }

async function editor() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!(await canEdit(user.email))) return { ok: false as const, error: 'Not authorized.' }
  return { ok: true as const, supabase, user }
}

function refresh(jobId?: string) {
  revalidatePath('/jobs')
  revalidatePath('/my-work')
  if (jobId) revalidatePath(`/jobs/${jobId}`)
}

type Supabase = Awaited<ReturnType<typeof createClient>>

async function notify(
  supabase: Supabase,
  rows: Array<{ recipient_id: string; kind: 'needs_action' | 'fyi'; reason: string; title: string; body?: string | null; job_id: string; step_id?: string | null; comment_id?: string | null }>,
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

async function follow(supabase: Supabase, jobId: string, profileId: string | null) {
  if (!profileId) return
  await supabase.from('job_followers').upsert({ job_id: jobId, profile_id: profileId }, { onConflict: 'job_id,profile_id', ignoreDuplicates: true })
}

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)

/** brand_id from a form: '' or 'internal' means no client. */
async function brandFrom(supabase: Supabase, formData: FormData): Promise<{ ok: true; id: string | null; name: string } | { ok: false; error: string }> {
  const raw = String(formData.get('brand_id') ?? '')
  if (!raw) return { ok: false, error: 'Pick a client, or Internal.' }
  if (raw === 'internal') return { ok: true, id: null, name: 'Internal' }
  const { data: brand } = await supabase.from('brands').select('name').eq('id', raw).single()
  if (!brand) return { ok: false, error: 'Unknown client.' }
  return { ok: true, id: raw, name: brand.name }
}

// ── create ─────────────────────────────────────────────────────────────────
/** A job from a workflow template: copies the template's steps and stages. */
export async function createJob(formData: FormData): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth

  const { data: tplRaw } = await supabase.from('workflow_templates').select('*').eq('id', String(formData.get('template_id') ?? '')).maybeSingle()
  const template = tplRaw as WorkflowTemplate | null
  if (!template || template.archived_at) return { ok: false, error: 'Pick a workflow.' }
  if (!template.steps.length) return { ok: false, error: `${template.name} has no steps yet.` }

  const brand = await brandFrom(supabase, formData)
  if (!brand.ok) return brand
  const startDate = String(formData.get('start_date') ?? '')         // YYYY-MM-DD
  const ownerId = String(formData.get('owner_id') ?? '') || user.id
  if (!isDate(startDate)) return { ok: false, error: 'Pick a start date.' }

  let targetMonth: string | null = null
  let slot: number | null = null
  let name = String(formData.get('name') ?? '').trim()
  if (template.uses_month_slot) {
    const month = String(formData.get('target_month') ?? '')          // YYYY-MM
    slot = Number(formData.get('slot') ?? 1)
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'Pick the month it’s for.' }
    targetMonth = `${month}-01`
    name ||= `${brand.name} · ${monthLabel(targetMonth)} · M${slot}`
  }
  name ||= `${brand.name} · ${template.name}`

  const { data: job, error } = await supabase.from('jobs').insert({
    kind: 'workflow', template_id: template.id, brand_id: brand.id, name,
    target_month: targetMonth, slot, start_date: startDate,
    due_date: addWorkingDays(startDate, templateLength(template.steps)),
    stages: template.stages, done_label: template.done_label, due_label: template.due_label,
    owner_id: ownerId, created_by: user.id,
  }).select('id').single()
  if (error || !job) return { ok: false, error: `Could not create the job: ${error?.message}` }

  const created = await insertTemplateSteps(supabase, job.id, startDate, template)
  if (!created.ok) {
    // Don't leave a job with no steps behind.
    await supabase.from('jobs').delete().eq('id', job.id)
    return created
  }
  // A workflow with offer steps gets its offer card straight away, so the
  // offer's review drives those steps from the start. Added after the steps:
  // the card's trigger links it to the job and syncs them.
  if (brand.id && targetMonth && template.steps.some(s => s.key === 'offer_draft')) {
    const { error: offerErr } = await supabase.from('offer_cards').insert({
      brand_id: brand.id, target_month: targetMonth, moment_slot: slot ?? 1, name, job_id: job.id, created_by: user.id,
    })
    if (offerErr) console.error('[createJob] offer card failed:', offerErr.message)
  }
  await follow(supabase, job.id, user.id)
  await follow(supabase, job.id, ownerId)
  if (ownerId !== user.id) {
    await notify(supabase, [{ recipient_id: ownerId, kind: 'fyi', reason: 'assigned', title: `You own a new job: ${name}`, job_id: job.id }], user.id)
  }
  refresh()
  return { ok: true, id: job.id }
}

async function insertTemplateSteps(supabase: Supabase, jobId: string, startDate: string, template: WorkflowTemplate): Promise<Result> {
  // Groups first, so children can point at them. A group sits where its first
  // step is in the template.
  // Every row lists every column: a bulk insert whose rows have different keys
  // sends NULL for the missing ones instead of using the column defaults.
  const row = (r: { id: string; parent_id: string | null; key: string | null; title: string; is_group: boolean; sort_order: number; due_date: string | null; stage: string | null; day_offset: number | null }) =>
    ({ job_id: jobId, status: 'todo', ...r })
  const groupIds: Record<string, string> = {}
  const childOrder: Record<string, number> = {}
  let order = 0
  const top: Array<ReturnType<typeof row>> = []
  const children: Array<ReturnType<typeof row>> = []
  for (const t of template.steps) {
    const step = { key: t.key, title: t.title, is_group: false, due_date: addWorkingDays(startDate, t.day), stage: t.stage, day_offset: t.day }
    if (!t.group) {
      top.push(row({ id: crypto.randomUUID(), parent_id: null, sort_order: order++, ...step }))
      continue
    }
    if (!groupIds[t.group]) {
      groupIds[t.group] = crypto.randomUUID()
      childOrder[t.group] = 0
      top.push(row({ id: groupIds[t.group], parent_id: null, key: null, title: t.group, is_group: true, sort_order: order++, due_date: null, stage: null, day_offset: null }))
    }
    children.push(row({ id: crypto.randomUUID(), parent_id: groupIds[t.group], sort_order: childOrder[t.group]++, ...step }))
  }
  const { error: e1 } = await supabase.from('job_steps').insert(top)
  if (e1) return { ok: false, error: `Could not add steps: ${e1.message}` }
  if (children.length) {
    const { error: e2 } = await supabase.from('job_steps').insert(children)
    if (e2) return { ok: false, error: `Could not add steps: ${e2.message}` }
  }
  return { ok: true }
}

/** A one-off task: a job with one step, for work that has no workflow. */
export async function createTask(formData: FormData): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth

  const title = String(formData.get('title') ?? '').trim()
  const dueDate = String(formData.get('due_date') ?? '')
  const ownerId = String(formData.get('owner_id') ?? '') || user.id
  if (!title) return { ok: false, error: 'Say what needs doing.' }
  if (dueDate && !isDate(dueDate)) return { ok: false, error: 'That due date doesn’t look right.' }
  const brand = await brandFrom(supabase, formData)
  if (!brand.ok) return brand

  const { data: job, error } = await supabase.from('jobs').insert({
    kind: 'task', brand_id: brand.id, name: title, start_date: new Date().toISOString().slice(0, 10),
    due_date: dueDate || null, owner_id: ownerId, created_by: user.id,
  }).select('id').single()
  if (error || !job) return { ok: false, error: `Could not create the task: ${error?.message}` }
  const { data: step, error: e2 } = await supabase.from('job_steps').insert({
    job_id: job.id, title, assignee_id: ownerId, due_date: dueDate || null, sort_order: 0,
  }).select('id').single()
  if (e2 || !step) {
    await supabase.from('jobs').delete().eq('id', job.id)
    return { ok: false, error: `Could not create the task: ${e2?.message}` }
  }
  await follow(supabase, job.id, user.id)
  await follow(supabase, job.id, ownerId)
  await notify(supabase, [{
    recipient_id: ownerId, kind: 'needs_action', reason: 'assigned',
    title: `You own “${title}”`, body: brand.name, job_id: job.id, step_id: step.id,
  }], user.id)
  refresh()
  return { ok: true, id: job.id }
}

// ── steps ──────────────────────────────────────────────────────────────────
export async function updateStep(
  stepId: string,
  patch: { status?: StepStatus; assignee_id?: string | null; due_date?: string | null; title?: string },
): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth

  const { data: step } = await supabase.from('job_steps').select('id, job_id, key, title, assignee_id, jobs(name, kind, status, offer_card_id, project_id)').eq('id', stepId).single()
  if (!step) return { ok: false, error: 'Step not found.' }
  const clean: Record<string, unknown> = {}
  if (patch.status) {
    // A linked step moves with its card's review, never by hand.
    const links = step.jobs as unknown as { offer_card_id: string | null; project_id: string | null } | null
    if (links && isLinkedStep(step, links)) return { ok: false, error: 'This step moves with the review. Use the review buttons on the step.' }
    clean.status = patch.status
  }
  if ('assignee_id' in patch) clean.assignee_id = patch.assignee_id || null
  if ('due_date' in patch) clean.due_date = patch.due_date || null
  if (patch.title !== undefined) {
    if (!patch.title.trim()) return { ok: false, error: 'A step needs a name.' }
    clean.title = patch.title.trim()
  }
  const { error } = await supabase.from('job_steps').update(clean).eq('id', stepId)
  if (error) return { ok: false, error: error.message }

  const job = step.jobs as unknown as { name: string; kind: string; status: JobStatus } | null
  // A task is its one step: keep the task's name, owner, date and status in step.
  if (job?.kind === 'task') {
    const mirror: Record<string, unknown> = {}
    if ('title' in clean) mirror.name = clean.title
    if ('assignee_id' in clean) mirror.owner_id = clean.assignee_id
    if ('due_date' in clean) mirror.due_date = clean.due_date
    if (patch.status) {
      if (!isOpen(patch.status) && job.status === 'active') mirror.status = 'done'
      if (isOpen(patch.status) && job.status === 'done') mirror.status = 'active'
    }
    if (Object.keys(mirror).length) await supabase.from('jobs').update(mirror).eq('id', step.job_id)
  }

  const jobName = job?.name ?? 'a job'
  if (clean.assignee_id && clean.assignee_id !== step.assignee_id) {
    await notify(supabase, [{
      recipient_id: clean.assignee_id as string, kind: 'needs_action', reason: 'assigned',
      title: `You own “${step.title}”`, body: jobName, job_id: step.job_id, step_id: stepId,
    }], user.id)
    await follow(supabase, step.job_id, clean.assignee_id as string)
  }
  refresh(step.job_id)
  return { ok: true }
}

export async function addStep(jobId: string, parentId: string | null, title: string, dueDate: string | null): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase } = auth
  if (!title.trim()) return { ok: false, error: 'A step needs a name.' }
  let q = supabase.from('job_steps').select('sort_order').eq('job_id', jobId).order('sort_order', { ascending: false }).limit(1)
  q = parentId ? q.eq('parent_id', parentId) : q.is('parent_id', null)
  const { data: last } = await q.maybeSingle()
  const { error } = await supabase.from('job_steps').insert({
    job_id: jobId, parent_id: parentId, title: title.trim(), due_date: dueDate || null,
    sort_order: (last?.sort_order ?? -1) + 1,
  })
  if (error) return { ok: false, error: error.message }
  refresh(jobId)
  return { ok: true }
}

export async function deleteStep(stepId: string): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase } = auth
  const { data: step } = await supabase.from('job_steps').select('job_id').eq('id', stepId).single()
  const { error } = await supabase.from('job_steps').delete().eq('id', stepId)
  if (error) return { ok: false, error: error.message }
  refresh(step?.job_id)
  return { ok: true }
}

// ── job ────────────────────────────────────────────────────────────────────
export async function updateJob(
  jobId: string,
  patch: { owner_id?: string | null; due_date?: string | null; status?: JobStatus },
): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  const { error } = await supabase.from('jobs').update(patch).eq('id', jobId)
  if (error) return { ok: false, error: error.message }
  if (patch.owner_id) {
    await follow(supabase, jobId, patch.owner_id)
    await notify(supabase, [{ recipient_id: patch.owner_id, kind: 'fyi', reason: 'assigned', title: 'You now own a job', job_id: jobId }], user.id)
  }
  refresh(jobId)
  return { ok: true }
}

/** Re-plan every open step from a new start date, using each step's day from its template. */
export async function rescheduleJob(jobId: string, startDate: string): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase } = auth
  if (!isDate(startDate)) return { ok: false, error: 'Pick a start date.' }
  const { data: steps } = await supabase.from('job_steps').select('id, day_offset, status').eq('job_id', jobId)
  let last = 0
  for (const s of steps ?? []) {
    if (s.day_offset === null) continue
    last = Math.max(last, s.day_offset)
    if (s.status === 'done' || s.status === 'skipped') continue
    await supabase.from('job_steps').update({ due_date: addWorkingDays(startDate, s.day_offset) }).eq('id', s.id)
  }
  await supabase.from('jobs').update({ start_date: startDate, due_date: addWorkingDays(startDate, last) }).eq('id', jobId)
  refresh(jobId)
  return { ok: true }
}

export async function setFollowing(jobId: string, following: boolean): Promise<Result> {
  const auth = await editor()
  if (!auth.ok) return auth
  const { supabase, user } = auth
  if (following) await follow(supabase, jobId, user.id)
  else await supabase.from('job_followers').delete().eq('job_id', jobId).eq('profile_id', user.id)
  refresh(jobId)
  return { ok: true }
}

// ── comments ───────────────────────────────────────────────────────────────
export async function addComment(input: {
  jobId: string
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
    const { data: parent } = await supabase.from('step_comments').select('id, parent_id, job_id, author_id').eq('id', input.parentId).single()
    if (!parent || parent.job_id !== input.jobId) return { ok: false, error: 'That thread no longer exists.' }
    parentId = parent.parent_id ?? parent.id
    const { data: thread } = await supabase.from('step_comments').select('author_id, mentions').or(`id.eq.${parentId},parent_id.eq.${parentId}`)
    threadPeople = [...new Set((thread ?? []).flatMap(c => [c.author_id, ...(c.mentions ?? [])]).filter((x): x is string => !!x))]
  }

  const { data: comment, error } = await supabase.from('step_comments').insert({
    job_id: input.jobId, step_id: input.stepId, author_id: user.id, body, kind: input.kind, mentions: input.mentions, parent_id: parentId,
  }).select('id').single()
  if (error || !comment) return { ok: false, error: error?.message ?? 'Could not post.' }

  const [{ data: step }, { data: job }, { data: followers }] = await Promise.all([
    input.stepId ? supabase.from('job_steps').select('title, assignee_id').eq('id', input.stepId).single() : Promise.resolve({ data: null }),
    supabase.from('jobs').select('name').eq('id', input.jobId).single(),
    supabase.from('job_followers').select('profile_id').eq('job_id', input.jobId),
  ])
  const where = step ? `${step.title} · ${job?.name ?? ''}` : job?.name ?? ''
  const preview = body.length > 180 ? `${body.slice(0, 177)}…` : body
  const base = { job_id: input.jobId, step_id: input.stepId, comment_id: comment.id, body: preview }

  // Order matters: notify() keeps the first row per person, so the strongest
  // reason wins (a mentioned follower gets the mention, not the FYI).
  const rows = [
    ...input.mentions.map(id => ({ ...base, recipient_id: id, kind: (input.kind === 'needs_action' ? 'needs_action' : 'fyi') as 'needs_action' | 'fyi', reason: 'mentioned', title: `${input.kind === 'needs_action' ? 'Action needed' : 'You were mentioned'}: ${where}` })),
    ...threadPeople.map(id => ({ ...base, recipient_id: id, kind: 'fyi' as const, reason: 'reply', title: `New reply: ${where}` })),
    ...(step?.assignee_id ? [{ ...base, recipient_id: step.assignee_id, kind: 'fyi' as const, reason: 'comment_on_my_step', title: `New comment on your step: ${where}` }] : []),
    ...(input.kind === 'note' ? [] : (followers ?? []).map(f => ({ ...base, recipient_id: f.profile_id, kind: 'fyi' as const, reason: 'following', title: `Update: ${where}` }))),
  ]
  await notify(supabase, rows, user.id)
  for (const id of input.mentions) await follow(supabase, input.jobId, id)
  await follow(supabase, input.jobId, user.id)
  refresh(input.jobId)
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
