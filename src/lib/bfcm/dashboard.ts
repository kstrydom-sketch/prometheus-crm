/** Production progress across every brand, for the BFCM list page. Pure; safe for client and server. */
import { daysBetween, easternDateOf } from '../eastern'
import type { Draft } from './model'
import { phaseAllocation } from './phase-allocation'
import { KIND_CATEGORIES, PHASE_LABEL, effectiveStatus, planKeyCount, type Person, type Phase, type TaskNode } from './production'

export type MadeEntry = { delta: number; created_at: string }
export type PlanStage = 'none' | 'draft' | 'locked'
export type BrandInput = {
  slug: string; name: string; cap: number; stage: PlanStage
  draft: Pick<Draft, 'allocation' | 'prePercent' | 'noPreBf' | 'offers'>
  tasks: TaskNode[]
}
export type Tally = { made: number; total: number }
export type Launch = { label: string; date: string; days: number; left: number }
export type StepProgress = { kind: string; label: string; status: 'todo' | 'in_progress' | 'waiting_client' | 'done' }
export type TaskCounts = { todo: number; inProgress: number; waiting: number; done: number }
export type Flag = { text: string; level: 'critical' | 'warning' }
export type BrandProgress = Tally & {
  slug: string; name: string; stage: PlanStage
  inWork: number; waiting: number; notStarted: number
  statics: Tally; motion: Tally
  launch: Launch | null
  /** Creatives a day to hit every dated launch; null when nothing dated is left. */
  needPerDay: number | null
  undatedLeft: number
  steps: StepProgress[]
  tasks: TaskCounts
  flags: Flag[]
}
export type PersonLoad = { id: string; name: string; open: number; overdue: number; creatives: number }
export type Board = Tally & {
  inWork: number; waiting: number; notStarted: number
  statics: Tally; motion: Tally; phases: Record<Phase, Tally>
  needPerDay: number; undatedLeft: number
  madeToday: number; madePerDay: number
  launch: (Launch & { brand: string }) | null
  tasks: TaskCounts
  locked: number; withTasks: number; overdue: number
  brands: BrandProgress[]; people: PersonLoad[]
}

type Bucket = 'made' | 'inWork' | 'waiting' | 'notStarted'
/** Unknown values (a newer status from another branch) count as being worked on. */
function bucketOf(status: string): Bucket {
  if (status === 'done') return 'made'
  if (status === 'todo') return 'notStarted'
  return status === 'waiting_client' ? 'waiting' : 'inWork'
}

/** A plan row's status and count: its own subtask, or the Make step's when the step was never split by plan. */
function rowState(tasks: TaskNode[], kind: string, planKey: string, quantity: number): { made: number; rest: Bucket } {
  const step = tasks.find(t => t.kind === kind)
  if (!step) return { made: 0, rest: 'notStarted' }
  const linked = step.children.find(c => c.plan_key === planKey)
  if (linked) {
    const bucket = bucketOf(effectiveStatus(linked))
    return { made: bucket === 'made' ? quantity : Math.min(linked.made_count, quantity), rest: bucket === 'made' ? 'notStarted' : bucket }
  }
  if (step.children.some(c => c.plan_key)) return { made: 0, rest: 'notStarted' }
  const bucket = bucketOf(effectiveStatus(step))
  return { made: bucket === 'made' ? quantity : 0, rest: bucket === 'made' ? 'notStarted' : bucket }
}

const STEP_LABELS: [string, string][] = [['review', 'Review'], ['samples', 'Calibration'], ['statics', 'Statics'], ['motion', 'Motion'], ['check', 'Check']]
function stepStatus(status: string): StepProgress['status'] {
  return status === 'done' || status === 'todo' || status === 'waiting_client' ? status : 'in_progress'
}
const flatten = (nodes: TaskNode[]): TaskNode[] => nodes.flatMap(n => [n, ...flatten(n.children)])
const openLeaves = (tasks: TaskNode[]) => flatten(tasks).filter(n => !n.children.length && effectiveStatus(n) !== 'done')
function taskCounts(tasks: TaskNode[]): TaskCounts {
  const counts: TaskCounts = { todo: 0, inProgress: 0, waiting: 0, done: 0 }
  for (const task of flatten(tasks)) {
    if (task.children.length) continue
    const status = stepStatus(effectiveStatus(task))
    counts[status === 'todo' ? 'todo' : status === 'done' ? 'done' : status === 'waiting_client' ? 'waiting' : 'inProgress']++
  }
  return counts
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function brandProgress(input: BrandInput, today: string): BrandProgress {
  const { draft, tasks } = input
  const allocation = phaseAllocation(draft)
  const counts: Record<Bucket, number> = { made: 0, inWork: 0, waiting: 0, notStarted: 0 }
  const statics: Tally = { made: 0, total: 0 }
  const motion: Tally = { made: 0, total: 0 }
  const left: Record<Phase, number> = { pre: 0, bf: 0 }
  for (const [kind, tally] of [['statics', statics], ['motion', motion]] as const) {
    for (const category of KIND_CATEGORIES[kind] ?? []) {
      const row = allocation.rows.find(r => r.id === category)
      if (!row) continue
      for (const phase of ['pre', 'bf'] as Phase[]) {
        const { made, rest } = rowState(tasks, kind, `${category}:${phase}`, row[phase])
        counts.made += made
        counts[rest] += row[phase] - made
        tally.total += row[phase]
        tally.made += made
        left[phase] += row[phase] - made
      }
    }
  }
  // A draft can be short of the contract; what isn't allocated still has to be made.
  const unallocated = Math.max(0, input.cap - allocation.total)
  counts.notStarted += unallocated
  left.bf += unallocated

  const launches = (['pre', 'bf'] as Phase[]).flatMap(phase => {
    const date = draft.offers[phase].startDate
    return left[phase] > 0 && date ? [{ label: PHASE_LABEL[phase], date, days: daysBetween(today, date), left: left[phase] }] : []
  }).sort((a, b) => a.date.localeCompare(b.date))
  const undatedLeft = (['pre', 'bf'] as Phase[]).reduce((sum, phase) => sum + (draft.offers[phase].startDate ? 0 : left[phase]), 0)
  const launch = launches[0] ?? null

  const open = openLeaves(tasks)
  const overdue = open.filter(t => t.due_date && t.due_date < today).length
  const unassigned = open.filter(t => !t.assignees.length).length
  const undated = open.filter(t => !t.due_date).length
  const waitingOn = open.filter(t => effectiveStatus(t) === 'waiting_client')
  const flags: Flag[] = []
  for (const l of launches) if (l.days < 0) flags.push({ level: 'critical', text: `${l.left} late for ${l.label}` })
  if (overdue) flags.push({ level: 'critical', text: `${plural(overdue, 'task')} overdue` })
  for (const t of waitingOn) flags.push({ level: 'warning', text: `Waiting on client: ${t.title}` })
  if (input.stage !== 'locked') flags.push({ level: launch && launch.days <= 14 ? 'critical' : 'warning', text: input.stage === 'none' ? 'Onboarding not started' : 'Plan not locked' })
  if (!tasks.length) flags.push({ level: 'warning', text: 'No tasks set up' })
  if (undatedLeft) flags.push({ level: 'warning', text: 'No launch date' })
  if (unassigned) flags.push({ level: 'warning', text: `${plural(unassigned, 'task')} unassigned` })
  if (undated) flags.push({ level: 'warning', text: `${plural(undated, 'task')} without a due date` })
  for (const [kind, label] of [['statics', 'Statics'], ['motion', 'Motion']]) {
    const step = tasks.find(t => t.kind === kind)
    if (step && effectiveStatus(step) !== 'done' && !step.children.some(c => c.plan_key)) flags.push({ level: 'warning', text: `${label} not split by plan, so it can't be counted` })
  }
  if (unallocated) flags.push({ level: 'warning', text: `${unallocated} not allocated` })

  const total = allocation.total + unallocated
  return {
    slug: input.slug, name: input.name, stage: input.stage,
    made: counts.made, total, inWork: counts.inWork, waiting: counts.waiting, notStarted: counts.notStarted,
    statics, motion, launch,
    needPerDay: launches.length ? launches.reduce((sum, l) => sum + l.left / Math.max(l.days, 1), 0) : null,
    undatedLeft,
    steps: STEP_LABELS.flatMap(([kind, label]) => {
      const step = tasks.find(t => t.kind === kind)
      return step ? [{ kind, label, status: stepStatus(effectiveStatus(step)) }] : []
    }),
    tasks: taskCounts(tasks),
    flags,
  }
}

export function productionBoard(inputs: BrandInput[], people: Person[], today: string, log: MadeEntry[] = []): Board {
  const brands = inputs.map(input => brandProgress(input, today)).sort((a, b) =>
    (a.launch?.date ?? '9999').localeCompare(b.launch?.date ?? '9999') || b.total - a.total || a.name.localeCompare(b.name))
  const sum = (pick: (b: BrandProgress) => number) => brands.reduce((n, b) => n + pick(b), 0)
  const phases: Record<Phase, Tally> = { pre: { made: 0, total: 0 }, bf: { made: 0, total: 0 } }
  const loads = new Map(people.map(p => [p.id, { ...p, open: 0, overdue: 0, creatives: 0 }]))
  for (const input of inputs) {
    const allocation = phaseAllocation(input.draft)
    phases.pre.total += allocation.pre
    phases.bf.total += allocation.bf + Math.max(0, input.cap - allocation.total)
    for (const [kind, categories] of Object.entries(KIND_CATEGORIES)) for (const category of categories ?? []) for (const phase of ['pre', 'bf'] as Phase[]) {
      phases[phase].made += rowState(input.tasks, kind, `${category}:${phase}`, allocation.rows.find(r => r.id === category)?.[phase] ?? 0).made
    }
    for (const task of flatten(input.tasks)) {
      if (effectiveStatus(task) === 'done') continue
      for (const id of task.assignees) {
        const load = loads.get(id)
        if (!load) continue
        load.open++
        if (task.due_date && task.due_date < today) load.overdue++
        load.creatives += Math.max(0, (planKeyCount(task.plan_key, input.draft) ?? 0) - task.made_count)
      }
    }
  }
  const soonest = brands.find(b => b.launch)
  const daysAgo = (entry: MadeEntry) => daysBetween(easternDateOf(entry.created_at), today)
  const madeIn = (days: number) => log.filter(e => daysAgo(e) < days).reduce((n, e) => n + e.delta, 0)
  return {
    made: sum(b => b.made), total: sum(b => b.total), inWork: sum(b => b.inWork), waiting: sum(b => b.waiting), notStarted: sum(b => b.notStarted),
    statics: { made: sum(b => b.statics.made), total: sum(b => b.statics.total) },
    motion: { made: sum(b => b.motion.made), total: sum(b => b.motion.total) },
    phases,
    needPerDay: sum(b => b.needPerDay ?? 0),
    undatedLeft: sum(b => b.undatedLeft),
    madeToday: madeIn(1),
    madePerDay: madeIn(7) / 7,
    launch: soonest?.launch ? { ...soonest.launch, brand: soonest.name } : null,
    tasks: { todo: sum(b => b.tasks.todo), inProgress: sum(b => b.tasks.inProgress), waiting: sum(b => b.tasks.waiting), done: sum(b => b.tasks.done) },
    locked: brands.filter(b => b.stage === 'locked').length,
    withTasks: inputs.filter(b => b.tasks.length).length,
    overdue: inputs.reduce((n, b) => n + openLeaves(b.tasks).filter(t => t.due_date && t.due_date < today).length, 0),
    brands,
    people: [...loads.values()].filter(p => p.open).sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name)),
  }
}
