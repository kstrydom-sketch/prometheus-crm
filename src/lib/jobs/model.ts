// Jobs, workflow templates & steps: shared types, stage logic and working-day
// math. Safe for both server and browser — no server-only imports here.
//
// A job is any piece of client or internal work. Most jobs are made from a
// workflow template (Moments, Client onboarding, ...), which they copy at
// creation; a one-off task is a job with a single step and no template.

export type StepStatus = 'todo' | 'in_progress' | 'waiting_client' | 'blocked' | 'done' | 'skipped'
export type JobStatus = 'active' | 'done' | 'on_hold' | 'cancelled'
export type JobKind = 'workflow' | 'task'
export type CommentKind = 'note' | 'fyi' | 'needs_action'

export interface TemplateStage {
  key: string
  label: string
}

export interface TemplateStep {
  key: string
  title: string
  /** Working days from the job's start (day 0). */
  day: number
  /** Steps sharing a group label are shown together under it. */
  group: string | null
  /** Key of the stage this step counts towards. */
  stage: string | null
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string | null
  uses_month_slot: boolean
  done_label: string
  due_label: string
  stages: TemplateStage[]
  steps: TemplateStep[]
  sort_order: number
  archived_at: string | null
  updated_by: string | null
  updated_at: string
}

export interface Job {
  id: string
  kind: JobKind
  template_id: string | null
  brand_id: string | null
  name: string
  target_month: string | null
  slot: number | null
  start_date: string
  due_date: string | null
  status: JobStatus
  owner_id: string | null
  offer_card_id: string | null
  project_id: string | null
  stages: TemplateStage[]
  done_label: string
  due_label: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface JobStep {
  id: string
  job_id: string
  parent_id: string | null
  key: string | null
  title: string
  is_group: boolean
  sort_order: number
  assignee_id: string | null
  due_date: string | null
  status: StepStatus
  stage: string | null
  day_offset: number | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface StepComment {
  id: string
  job_id: string
  step_id: string | null
  author_id: string | null
  body: string
  kind: CommentKind
  mentions: string[]
  parent_id: string | null
  created_at: string
  edited_at: string | null
}

export interface ActivityRow {
  id: number
  job_id: string | null
  step_id: string | null
  entity: 'job' | 'step' | 'comment'
  action: 'created' | 'updated' | 'deleted' | 'commented'
  field: string | null
  old_value: string | null
  new_value: string | null
  actor_id: string | null
  created_at: string
}

export interface InboxItem {
  id: string
  recipient_id: string
  job_id: string | null
  step_id: string | null
  comment_id: string | null
  kind: 'needs_action' | 'fyi'
  reason: 'assigned' | 'mentioned' | 'following' | 'comment_on_my_step' | 'reply'
  actor_id: string | null
  title: string
  body: string | null
  cleared_at: string | null
  created_at: string
}

export const STEP_STATUS: Record<StepStatus, { label: string; fg: string; bg: string }> = {
  todo:           { label: 'To do',            fg: '#5C5346', bg: 'rgba(92, 83, 70, 0.10)' },
  in_progress:    { label: 'In progress',      fg: '#1D4ED8', bg: 'rgba(59, 130, 246, 0.14)' },
  waiting_client: { label: 'Waiting on client', fg: '#92400E', bg: 'rgba(245, 158, 11, 0.18)' },
  blocked:        { label: 'Blocked',          fg: '#B91C1C', bg: 'rgba(239, 68, 68, 0.14)' },
  done:           { label: 'Done',             fg: '#3F6212', bg: 'rgba(101, 163, 13, 0.18)' },
  skipped:        { label: 'Skipped',          fg: '#736856', bg: 'rgba(115, 104, 86, 0.10)' },
}
export const STEP_STATUS_ORDER: StepStatus[] = ['todo', 'in_progress', 'waiting_client', 'blocked', 'done', 'skipped']

export const JOB_STATUS_ORDER: JobStatus[] = ['active', 'on_hold', 'done', 'cancelled']
/** Job status label; 'done' reads as the template's own word ("Launched"). */
export function jobStatusLabel(status: JobStatus, doneLabel = 'Done'): string {
  return { active: 'Active', on_hold: 'On hold', done: doneLabel, cancelled: 'Cancelled' }[status]
}

export const COMMENT_KIND: Record<CommentKind, { label: string; hint: string }> = {
  note:         { label: 'Note',         hint: 'Discussion. Nobody is notified except people you @mention.' },
  fyi:          { label: 'FYI',          hint: 'Lands in people’s inbox to read and clear.' },
  needs_action: { label: 'Needs action', hint: 'Stays in their inbox until they do it and clear it.' },
}

/** The job's end date: the last step's day in the template. */
export function templateLength(steps: Pick<TemplateStep, 'day'>[]): number {
  return steps.reduce((max, s) => Math.max(max, s.day), 0)
}

/** Short, stable-enough key for a new stage or step in a template. */
export function newKey(label: string, taken: Iterable<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'item'
  const used = new Set(taken)
  let key = base
  for (let i = 2; used.has(key); i++) key = `${base}_${i}`
  return key
}

// ── dates ──────────────────────────────────────────────────────────────────
// Dates are 'YYYY-MM-DD' strings handled in UTC so they never shift a day.
const toUtc = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`)
const fromUtc = (d: Date) => d.toISOString().slice(0, 10)

export function addWorkingDays(start: string, days: number): string {
  const d = toUtc(start)
  let added = 0
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) added++
  }
  return fromUtc(d)
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000)
}

export function formatDue(d: string | null): string {
  if (!d) return 'No date'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(toUtc(d))
}

export function monthLabel(targetMonth: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toUtc(targetMonth))
}

export function isOpen(s: StepStatus): boolean {
  return s !== 'done' && s !== 'skipped'
}

/** Overdue = still open and the due date is before today. */
export function isOverdue(step: Pick<JobStep, 'status' | 'due_date' | 'is_group'>, today = todayIso()): boolean {
  return !step.is_group && isOpen(step.status) && !!step.due_date && step.due_date < today
}

/** A group's shown status, worked out from its children. */
export function groupStatus(children: Pick<JobStep, 'status'>[]): StepStatus {
  if (!children.length) return 'todo'
  if (children.every(c => !isOpen(c.status))) return 'done'
  if (children.some(c => c.status === 'blocked')) return 'blocked'
  if (children.some(c => c.status === 'waiting_client')) return 'waiting_client'
  if (children.some(c => c.status !== 'todo')) return 'in_progress'
  return 'todo'
}

// ── stage ──────────────────────────────────────────────────────────────────
// A job's stage is the earliest of its stages that still has open work, so it
// shows where the job is actually held up, even when later steps started
// early. Stages come from the job's own copy of its template.
export const DONE_STAGE = '__done'
const STAGE_COLORS = [
  { fg: '#475569', bg: 'rgba(148, 163, 184, 0.22)' },
  { fg: '#92400E', bg: 'rgba(245, 158, 11, 0.18)' },
  { fg: '#4338CA', bg: 'rgba(99, 102, 241, 0.14)' },
  { fg: '#1D4ED8', bg: 'rgba(59, 130, 246, 0.14)' },
  { fg: '#9D174D', bg: 'rgba(236, 72, 153, 0.13)' },
  { fg: '#BE123C', bg: 'rgba(244, 63, 94, 0.14)' },
  { fg: '#0E7490', bg: 'rgba(6, 182, 212, 0.16)' },
  { fg: '#6D28D9', bg: 'rgba(139, 92, 246, 0.14)' },
]
const DONE_COLOR = { fg: '#3F6212', bg: 'rgba(101, 163, 13, 0.18)' }

export interface StageInfo { key: string; label: string; fg: string; bg: string }

export function stageInfo(stages: TemplateStage[], key: string, doneLabel: string): StageInfo {
  if (key === DONE_STAGE) return { key, label: doneLabel, ...DONE_COLOR }
  const i = stages.findIndex(s => s.key === key)
  return { key, label: stages[i]?.label ?? key, ...STAGE_COLORS[Math.max(i, 0) % STAGE_COLORS.length] }
}

/** Stage key the job is in, or DONE_STAGE. Null for jobs with no stages (tasks). */
export function jobStage(stages: TemplateStage[], steps: Pick<JobStep, 'stage' | 'status' | 'is_group'>[]): string | null {
  if (!stages.length) return null
  for (const st of stages) {
    if (steps.some(s => !s.is_group && s.stage === st.key && isOpen(s.status))) return st.key
  }
  return DONE_STAGE
}

/** Steps in display order: top-level by sort_order, each group followed by its children. */
export function orderSteps<T extends Pick<JobStep, 'id' | 'parent_id' | 'sort_order'>>(steps: T[]): Array<T & { depth: number }> {
  const byParent = new Map<string | null, T[]>()
  for (const s of steps) {
    const list = byParent.get(s.parent_id) ?? []
    list.push(s)
    byParent.set(s.parent_id, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort_order - b.sort_order)
  const out: Array<T & { depth: number }> = []
  const walk = (parent: string | null, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      out.push({ ...s, depth })
      walk(s.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/** Plain-language line for one audit-log row. */
export function describeActivity(
  row: ActivityRow,
  name: (id: string | null) => string,
  stepTitle: (id: string | null) => string,
  job?: Pick<Job, 'done_label' | 'due_label' | 'stages'>,
): string {
  const who = row.actor_id ? name(row.actor_id) : 'System'
  const what = row.entity === 'job' ? 'the job' : row.entity === 'step' ? `“${stepTitle(row.step_id)}”` : 'a comment'
  if (row.action === 'created') return row.entity === 'step' ? `${who} added step “${row.new_value}”` : `${who} created ${what}`
  if (row.action === 'deleted') return `${who} removed ${row.entity === 'step' ? `step “${row.old_value}”` : 'a comment'}`
  if (row.action === 'commented') return `${who} commented${row.step_id ? ` on “${stepTitle(row.step_id)}”` : ''}`
  const field = row.field ?? ''
  if (field === 'status') {
    const to = row.entity === 'job'
      ? jobStatusLabel(row.new_value as JobStatus, job?.done_label)
      : STEP_STATUS[row.new_value as StepStatus]?.label ?? row.new_value
    return `${who} set ${what} to ${to}`
  }
  if (field === 'assignee_id' || field === 'owner_id') {
    return row.new_value ? `${who} assigned ${what} to ${name(row.new_value)}` : `${who} unassigned ${what}`
  }
  if (field === 'due_date') {
    const label = row.entity === 'job' ? `${(job?.due_label ?? 'due').toLowerCase()} date` : ''
    return `${who} moved ${what}${label ? ` ${label}` : ''} from ${formatDue(row.old_value)} to ${formatDue(row.new_value)}`
  }
  if (field === 'stage' && job) {
    return `${who} moved ${what} to the ${row.new_value ? stageInfo(job.stages, row.new_value, job.done_label).label : 'no'} stage`
  }
  if (field === 'title' || field === 'name') return `${who} renamed ${what} to “${row.new_value}”`
  return `${who} changed ${field.replace(/_/g, ' ')} on ${what}`
}
