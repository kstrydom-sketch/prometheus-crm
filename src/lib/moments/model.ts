// Moments & steps: shared types, the step template, and working-day math.
// Safe for both server and browser — no server-only imports here.

export type StepStatus = 'todo' | 'in_progress' | 'waiting_client' | 'blocked' | 'done' | 'skipped'
export type MomentStatus = 'active' | 'launched' | 'on_hold' | 'cancelled'
export type CommentKind = 'note' | 'fyi' | 'needs_action'

export interface Moment {
  id: string
  brand_id: string
  name: string
  target_month: string
  slot: number
  start_date: string
  launch_date: string | null
  status: MomentStatus
  owner_id: string | null
  offer_card_id: string | null
  project_id: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface MomentStep {
  id: string
  moment_id: string
  parent_id: string | null
  key: string | null
  title: string
  is_group: boolean
  sort_order: number
  assignee_id: string | null
  due_date: string | null
  status: StepStatus
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface StepComment {
  id: string
  moment_id: string
  step_id: string | null
  author_id: string | null
  body: string
  kind: CommentKind
  mentions: string[]
  created_at: string
  edited_at: string | null
}

export interface ActivityRow {
  id: number
  moment_id: string | null
  step_id: string | null
  entity: 'moment' | 'step' | 'comment'
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
  moment_id: string | null
  step_id: string | null
  comment_id: string | null
  kind: 'needs_action' | 'fyi'
  reason: 'assigned' | 'mentioned' | 'following' | 'comment_on_my_step'
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

export const COMMENT_KIND: Record<CommentKind, { label: string; hint: string }> = {
  note:         { label: 'Note',         hint: 'Discussion. Nobody is notified except people you @mention.' },
  fyi:          { label: 'FYI',          hint: 'Lands in people’s inbox to read and clear.' },
  needs_action: { label: 'Needs action', hint: 'Stays in their inbox until they do it and clear it.' },
}

// The cycle, in working days from the moment's start date (day 0):
//   1 offer written and reviewed · 4 client approves offer · 4 brief ready ·
//   7 LP and creatives built · 8 through internal review · 10 with the client ·
//   13 client edits done · 15 live.
export interface TemplateStep {
  key: string
  title: string
  day: number
  group?: 'lp' | 'creative'
}
export const TEMPLATE_GROUPS: Record<'lp' | 'creative', string> = { lp: 'Landing page', creative: 'Creatives' }
export const STEP_TEMPLATE: TemplateStep[] = [
  { key: 'offer_draft',            title: 'Write the offer',              day: 1 },
  { key: 'offer_internal_review',  title: 'Offer internal review',        day: 1 },
  { key: 'offer_client_approval',  title: 'Client approves the offer',    day: 4 },
  { key: 'brief',                  title: 'Compile the brief',            day: 4 },
  { key: 'lp_build',               title: 'Build the landing page',       day: 7,  group: 'lp' },
  { key: 'lp_internal_review',     title: 'Internal review',              day: 8,  group: 'lp' },
  { key: 'lp_client_review',       title: 'Client review',                day: 10, group: 'lp' },
  { key: 'lp_client_edits',        title: 'Apply client edits',           day: 13, group: 'lp' },
  { key: 'cr_drafts',              title: 'First drafts',                 day: 7,  group: 'creative' },
  { key: 'cr_internal_review',     title: 'Internal review',              day: 8,  group: 'creative' },
  { key: 'cr_client_review',       title: 'Client review',                day: 10, group: 'creative' },
  { key: 'cr_client_edits',        title: 'Apply client edits',           day: 13, group: 'creative' },
  { key: 'launch',                 title: 'Launch',                       day: 15 },
]
export const LAUNCH_DAY = 15

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
export function isOverdue(step: Pick<MomentStep, 'status' | 'due_date' | 'is_group'>, today = todayIso()): boolean {
  return !step.is_group && isOpen(step.status) && !!step.due_date && step.due_date < today
}

/** A group's shown status, worked out from its children. */
export function groupStatus(children: Pick<MomentStep, 'status'>[]): StepStatus {
  if (!children.length) return 'todo'
  if (children.every(c => !isOpen(c.status))) return 'done'
  if (children.some(c => c.status === 'blocked')) return 'blocked'
  if (children.some(c => c.status === 'waiting_client')) return 'waiting_client'
  if (children.some(c => c.status !== 'todo')) return 'in_progress'
  return 'todo'
}

// ── stage ──────────────────────────────────────────────────────────────────
// A moment's stage is the earliest phase that still has open work, so it shows
// where the moment is actually held up, even when later steps started early.
export type MomentStage = 'offer' | 'offer_approval' | 'brief' | 'production' | 'client_review' | 'client_edits' | 'launch' | 'launched'

export const MOMENT_STAGE: Record<MomentStage, { label: string; fg: string; bg: string; keys: string[] }> = {
  offer:          { label: 'Offer',            fg: '#475569', bg: 'rgba(148, 163, 184, 0.22)', keys: ['offer_draft', 'offer_internal_review'] },
  offer_approval: { label: 'Offer approval',   fg: '#92400E', bg: 'rgba(245, 158, 11, 0.18)',  keys: ['offer_client_approval'] },
  brief:          { label: 'Brief',            fg: '#4338CA', bg: 'rgba(99, 102, 241, 0.14)',  keys: ['brief'] },
  production:     { label: 'In production',    fg: '#1D4ED8', bg: 'rgba(59, 130, 246, 0.14)',  keys: ['lp_build', 'lp_internal_review', 'cr_drafts', 'cr_internal_review'] },
  client_review:  { label: 'Client review',    fg: '#92400E', bg: 'rgba(245, 158, 11, 0.18)',  keys: ['lp_client_review', 'cr_client_review'] },
  client_edits:   { label: 'Client edits',     fg: '#BE123C', bg: 'rgba(244, 63, 94, 0.14)',   keys: ['lp_client_edits', 'cr_client_edits'] },
  launch:         { label: 'Ready to launch',  fg: '#0E7490', bg: 'rgba(6, 182, 212, 0.16)',   keys: ['launch'] },
  launched:       { label: 'Launched',         fg: '#3F6212', bg: 'rgba(101, 163, 13, 0.18)',  keys: [] },
}
const STAGE_SEQUENCE: MomentStage[] = ['offer', 'offer_approval', 'brief', 'production', 'client_review', 'client_edits', 'launch']

export function momentStage(steps: Pick<MomentStep, 'key' | 'status' | 'is_group'>[]): MomentStage {
  for (const stage of STAGE_SEQUENCE) {
    const keys = MOMENT_STAGE[stage].keys
    if (steps.some(s => !s.is_group && s.key && keys.includes(s.key) && isOpen(s.status))) return stage
  }
  return 'launched'
}

/** Steps in display order: top-level by sort_order, each group followed by its children. */
export function orderSteps<T extends Pick<MomentStep, 'id' | 'parent_id' | 'sort_order'>>(steps: T[]): Array<T & { depth: number }> {
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
export function describeActivity(row: ActivityRow, name: (id: string | null) => string, stepTitle: (id: string | null) => string): string {
  const who = row.actor_id ? name(row.actor_id) : 'System'
  const what = row.entity === 'moment' ? 'the moment' : row.entity === 'step' ? `“${stepTitle(row.step_id)}”` : 'a comment'
  if (row.action === 'created') return row.entity === 'step' ? `${who} added step “${row.new_value}”` : `${who} created ${what}`
  if (row.action === 'deleted') return `${who} removed ${row.entity === 'step' ? `step “${row.old_value}”` : 'a comment'}`
  if (row.action === 'commented') return `${who} commented${row.step_id ? ` on “${stepTitle(row.step_id)}”` : ''}`
  const field = row.field ?? ''
  if (field === 'status') {
    const to = STEP_STATUS[row.new_value as StepStatus]?.label ?? row.new_value
    return `${who} set ${what} to ${to}`
  }
  if (field === 'assignee_id' || field === 'owner_id') {
    return row.new_value ? `${who} assigned ${what} to ${name(row.new_value)}` : `${who} unassigned ${what}`
  }
  if (field === 'due_date' || field === 'launch_date') {
    return `${who} moved ${what} ${field === 'launch_date' ? 'launch ' : ''}from ${formatDue(row.old_value)} to ${formatDue(row.new_value)}`
  }
  if (field === 'title' || field === 'name') return `${who} renamed ${what} to “${row.new_value}”`
  return `${who} changed ${field.replace(/_/g, ' ')} on ${what}`
}
