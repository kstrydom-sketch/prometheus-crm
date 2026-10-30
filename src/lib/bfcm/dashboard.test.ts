import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { brandProgress, productionBoard, type BrandInput } from './dashboard'
import { createDraft, type Brand } from './model'
import { buildTaskTree, type ProductionStep } from './production'

const brand: Brand = { slug: 'example', name: 'Example', cap: 100, aliases: [], contract: { kind: 'exact', quantities: { textOffer: 20, refreshedStatic: 20, newStatic: 20, refreshedVideo: 20, motionGraphics: 20 } } }
const offer = (startDate: string) => ({ offer: 'Offer', startDate, endDate: '2026-12-01', sitewide: true, included: '', hasExclusions: false, exclusions: '' })
const today = '2026-11-01'
const step = (id: string, kind: string, status = 'todo', extra: Partial<ProductionStep> = {}): ProductionStep =>
  ({ id, plan_slug: 'example', parent_id: null, sort_order: 1, kind, title: id, plan_key: null, due_date: null, status, made_count: 0, ...extra })
function input(steps: ProductionStep[], over: Partial<BrandInput> = {}, assignees: { step_id: string; profile_id: string }[] = []): BrandInput {
  const draft = { ...createDraft(brand), prePercent: 50, offers: { pre: offer('2026-11-11'), bf: offer('2026-11-21') } }
  return { slug: 'example', name: 'Example', cap: 100, stage: 'locked', draft, tasks: buildTaskTree(steps, assignees, {}), ...over }
}

test('a brand with no tasks has nothing made and says so', () => {
  const p = brandProgress(input([]), today)
  assert.deepEqual([p.made, p.total, p.notStarted], [0, 100, 100])
  assert.ok(p.flags.some(f => f.text === 'No tasks set up'))
})

test('an unsplit Make step counts all of its creatives', () => {
  const p = brandProgress(input([step('s', 'statics', 'done'), step('m', 'motion', 'in_progress')]), today)
  assert.deepEqual([p.made, p.inWork, p.statics, p.motion], [60, 40, { made: 60, total: 60 }, { made: 0, total: 40 }])
})

test('a split step counts only the finished rows; unlinked rows are not started', () => {
  const p = brandProgress(input([
    step('s', 'statics'),
    step('a', 'task', 'done', { parent_id: 's', plan_key: 'textOffer:pre' }),
    step('b', 'task', 'waiting_client', { parent_id: 's', plan_key: 'textOffer:bf' }),
  ]), today)
  assert.deepEqual([p.made, p.waiting, p.notStarted], [10, 10, 80])
})

test('an unknown status counts as being worked on instead of crashing', () => {
  assert.equal(brandProgress(input([step('s', 'statics', 'changes_requested')]), today).inWork, 60)
})

test('pace splits what is left over the days to each launch', () => {
  const p = brandProgress(input([]), today)
  assert.equal(p.launch?.label, 'Pre-BF')
  assert.equal(p.launch?.days, 10)
  assert.equal(p.needPerDay, 50 / 10 + 50 / 20)
})

test('undated work is left out of the pace and flagged', () => {
  const base = input([])
  const p = brandProgress({ ...base, draft: { ...base.draft, offers: { pre: offer(''), bf: offer('2026-11-21') } } }, today)
  assert.deepEqual([p.needPerDay, p.undatedLeft], [2.5, 50])
  assert.ok(p.flags.some(f => f.text === 'No launch date'))
})

test('a phase past its launch with work left is late; a finished one is not', () => {
  const late = brandProgress(input([], {}), '2026-11-15')
  assert.equal(late.flags[0].text, '50 late for Pre-BF')
  const done = brandProgress(input([step('s', 'statics', 'done'), step('m', 'motion', 'done')]), '2026-11-15')
  assert.deepEqual([done.launch, done.needPerDay, done.flags.filter(f => f.level === 'critical')], [null, null, []])
})

test('allocation short of the contract still counts toward the total', () => {
  const base = input([])
  const p = brandProgress({ ...base, draft: { ...base.draft, allocation: { ...base.draft.allocation, motionGraphics: 0 } } }, today)
  assert.deepEqual([p.total, p.notStarted], [100, 100])
  assert.ok(p.flags.some(f => f.text === '20 not allocated'))
})

test('the board adds brands up and loads people by their open tasks', () => {
  const board = productionBoard([input([
    step('s', 'statics'),
    step('a', 'task', 'todo', { parent_id: 's', plan_key: 'newStatic:pre', due_date: '2026-10-30' }),
    step('b', 'task', 'done', { parent_id: 's', plan_key: 'newStatic:bf' }),
  ], {}, [{ step_id: 'a', profile_id: 'p1' }, { step_id: 'b', profile_id: 'p1' }])], [{ id: 'p1', name: 'Maker' }, { id: 'p2', name: 'Idle' }], today)
  assert.deepEqual([board.made, board.total, board.overdue, board.phases.bf], [10, 100, 1, { made: 10, total: 50 }])
  assert.deepEqual(board.people, [{ id: 'p1', name: 'Maker', open: 1, overdue: 1, creatives: 10 }])
})

test('every step status shows, and calibration waiting on the client is surfaced', () => {
  const p = brandProgress(input([
    step('r', 'review', 'done'),
    step('c', 'samples'),
    step('cs', 'calibration_statics', 'waiting_client', { parent_id: 'c', title: 'Statics samples' }),
    step('cm', 'calibration_motion', 'in_progress', { parent_id: 'c' }),
    step('s', 'statics'),
  ]), today)
  assert.deepEqual(p.steps.map(s => [s.label, s.status]), [['Review', 'done'], ['Calibration', 'in_progress'], ['Statics', 'todo']])
  assert.deepEqual(p.tasks, { todo: 1, inProgress: 1, waiting: 1, done: 1 })
  assert.ok(p.flags.some(f => f.text === 'Waiting on client: Statics samples'))
})

test('a partial count shows as made and the rest stays in its status', () => {
  const p = brandProgress(input([
    step('s', 'statics'),
    step('a', 'task', 'in_progress', { parent_id: 's', plan_key: 'textOffer:pre', made_count: 4 }),
    step('b', 'task', 'waiting_client', { parent_id: 's', plan_key: 'textOffer:bf', made_count: 99 }),
  ]), today)
  assert.deepEqual([p.made, p.inWork, p.waiting, p.statics.made], [14, 6, 0, 14])
})

test('an unsplit Make step is flagged because it cannot be counted', () => {
  assert.ok(brandProgress(input([step('s', 'statics')]), today).flags.some(f => f.text.startsWith('Statics not split')))
})

test('pace comes from the log, corrections included', () => {
  const board = productionBoard([input([])], [], today, [
    { delta: 30, created_at: '2026-11-01T15:00:00Z' },
    { delta: -2, created_at: '2026-11-01T16:00:00Z' },
    { delta: 7, created_at: '2026-10-28T15:00:00Z' },
    { delta: 500, created_at: '2026-10-20T15:00:00Z' },
  ])
  assert.deepEqual([board.madeToday, board.madePerDay], [28, 5])
})
