/** Production steps after the plan: who makes what by when. Pure; safe for client and server. */
import type { Allocation } from './model'

export type StepKind = 'review' | 'samples' | 'statics' | 'motion' | 'check'
export type StepStatus = 'todo' | 'in_progress' | 'done'
export type ProductionStep = { id: string; plan_slug: string; sort_order: number; kind: string; title: string; owner_id: string | null; due_date: string | null; status: string }

export const DEFAULT_STEPS: { kind: StepKind; title: string; sort_order: number }[] = [
  { kind: 'review', title: 'Review client plan & split', sort_order: 1 },
  { kind: 'samples', title: 'Samples for client check', sort_order: 2 },
  { kind: 'statics', title: 'Make statics', sort_order: 3 },
  { kind: 'motion', title: 'Make motion', sort_order: 4 },
  { kind: 'check', title: 'Internal check & send', sort_order: 5 },
]
export const STEP_STATUSES: { id: StepStatus; label: string }[] = [
  { id: 'todo', label: 'Not started' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
]
/** Unknown values (a newer status from another branch) show as text instead of crashing. */
export function stepStatusLabel(status: string): string { return STEP_STATUSES.find(s => s.id === status)?.label ?? status }

/** Counts come from the plan's current split, so they never drift from it. */
export function productionCounts(allocation: Allocation) {
  return {
    statics: { total: allocation.textOffer + allocation.refreshedStatic + allocation.newStatic, detail: `${allocation.textOffer} text-only · ${allocation.refreshedStatic} refreshed · ${allocation.newStatic} new` },
    motion: { total: allocation.refreshedVideo + allocation.motionGraphics, detail: `${allocation.refreshedVideo} refreshed · ${allocation.motionGraphics} motion graphics` },
  }
}

/** First unfinished step, for the brand card on the list page. */
export function productionSummary(steps: ProductionStep[]) {
  const ordered = [...steps].sort((a, b) => a.sort_order - b.sort_order)
  const done = ordered.filter(s => s.status === 'done').length
  const next = ordered.find(s => s.status !== 'done') ?? null
  return { done, total: ordered.length, next }
}
