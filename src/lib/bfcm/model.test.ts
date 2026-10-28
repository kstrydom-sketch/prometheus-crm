import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createDraft, updateDraft, approveCopies, lockDraft, reopenDraft, validateAllocation, validateOffers, stageQuantities, parseStoredDraft, type Brand, type Draft } from './model'
const brand: Brand = { slug: 'example-brand', name: 'Example Brand', cap: 100, aliases: [], contract: { kind: 'exact', quantities: { textOffer: 20, refreshedStatic: 20, newStatic: 20, refreshedVideo: 20, motionGraphics: 20 } } }
const groupedBrand: Brand = { slug: 'example-grouped', name: 'Example Grouped Brand', cap: 100, aliases: [], contract: { kind: 'grouped', static: 70, motion: 30 } }
const flexibleBrand: Brand = { slug: 'example-flexible', name: 'Example Flexible Brand', cap: 100, aliases: [], contract: { kind: 'flexible' } }
function completed(): Draft {
  let draft = createDraft(brand)
  const offer = { offer: 'Current approved offer', startDate: '2026-11-01', endDate: '2026-11-30', sitewide: true, included: '', hasExclusions: false, exclusions: '' }
  draft = updateDraft(draft, { offers: { pre: { ...offer }, bf: { ...offer } }, copies: draft.copies.map((c, i) => ({ ...c, text: `Copy ${i + 1}` })), motionIds: ['validated-reference'] })
  return approveCopies(draft)
}
test('30 blank Nova lines are never implicitly approved', () => {
  const draft = createDraft(brand)
  assert.equal(draft.copies.length, 30); assert.ok(draft.copies.every(c => c.source === 'Nova' && !c.text)); assert.equal(draft.approvedCopiesRevision, null)
  assert.throws(() => approveCopies(draft))
  assert.throws(() => createDraft(brand, []))
})
test('allocation respects exact and grouped caps and integer totals', () => {
  for (const b of [brand, groupedBrand, flexibleBrand]) assert.deepEqual(validateAllocation(b, createDraft(b).allocation), [])
  const a = createDraft(brand).allocation
  assert.ok(validateAllocation(brand, { ...a, textOffer: 21, newStatic: 19 }).length)
  assert.ok(validateAllocation(brand, { ...a, textOffer: -1 }).length)
  assert.ok(validateAllocation(brand, { ...a, textOffer: NaN }).length)
  const grouped = createDraft(groupedBrand).allocation
  assert.ok(validateAllocation(groupedBrand, { ...grouped, newStatic: 69, motionGraphics: 31 }).length)
  assert.deepEqual(stageQuantities(301, 30), { pre: 90, bf: 211 })
})
test('category locks are enforced in domain, not only disabled inputs', () => {
  const draft = updateDraft(createDraft(brand), { allocationLocks: ['textOffer'] })
  assert.throws(() => updateDraft(draft, { allocation: { ...draft.allocation, textOffer: 19 } }))
})
test('both offer stages require dates/inclusions/conditional exclusions', () => {
  const draft = completed()
  assert.deepEqual(validateOffers(draft.offers), [])
  assert.ok(validateOffers({ ...draft.offers, pre: { ...draft.offers.pre, offer: '' } }).length)
  assert.ok(validateOffers({ ...draft.offers, bf: { ...draft.offers.bf, startDate: '2026-02-30' } }).length)
  assert.ok(validateOffers({ ...draft.offers, bf: { ...draft.offers.bf, sitewide: false } }).length)
  assert.ok(validateOffers({ ...draft.offers, bf: { ...draft.offers.bf, hasExclusions: true } }).length)
})
test('explicit approval invalidates on copy or current-offer changes', () => {
  const draft = completed()
  assert.equal(draft.approvedCopiesRevision, draft.copyRevision)
  assert.equal(updateDraft(draft, { sfx: true }).approvedCopiesRevision, draft.copyRevision)
  assert.equal(updateDraft(draft, { copies: draft.copies }).approvedCopiesRevision, null)
  assert.equal(updateDraft(draft, { offers: draft.offers }).approvedCopiesRevision, null)
})
test('lock and reopen require explicit confirmations and retain immutable version snapshots', () => {
  const draft = completed()
  assert.throws(() => lockDraft(brand, draft, false))
  const locked = lockDraft(brand, draft, true, '2026-10-28T00:00:00Z')
  assert.equal(locked.status, 'locked'); assert.equal(locked.history.length, 1)
  assert.throws(() => updateDraft(locked, { sfx: true })); assert.throws(() => reopenDraft(locked, false))
  const reopened = reopenDraft(locked, true)
  assert.equal(reopened.approvedCopiesRevision, null)
  reopened.copies[0].text = 'changed'
  assert.notEqual(locked.history[0].snapshot.copies[0].text, 'changed')
  const relocked = lockDraft(brand, approveCopies(reopened), true)
  assert.equal(relocked.history.length, 2); assert.equal(relocked.history[1].version, 2)
})
test('stored drafts reject corruption and cross-client loading', () => {
  const draft = completed()
  assert.deepEqual(parseStoredDraft(JSON.stringify(draft), brand.slug), draft)
  assert.equal(parseStoredDraft(JSON.stringify(draft), 'other-example-brand'), null)
  assert.equal(parseStoredDraft('{broken', brand.slug), null)
  assert.equal(parseStoredDraft(JSON.stringify({ ...draft, copies: [] }), brand.slug), null)
  assert.equal(parseStoredDraft(JSON.stringify({ ...draft, approvedCopiesRevision: 900 }), brand.slug), null)
  const locked = lockDraft(brand, draft, true)
  assert.deepEqual(parseStoredDraft(JSON.stringify(locked), brand.slug), locked)
})
