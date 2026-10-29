import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { planDriveSync, sampleName } from './calibration-drive'

const file = (id: string, mimeType = 'image/png', modifiedTime = '2026-10-30T10:00:00Z') => ({ id, name: `${id}.png`, mimeType, modifiedTime })

test('new files are added, edited files refreshed, unchanged and unsupported counted', () => {
  const plan = planDriveSync(
    [file('newfile0001'), file('samefile001'), file('editedfile1', 'image/png', '2026-10-31T09:00:00Z'), file('notes000001', 'application/pdf')],
    [{ id: 'a', drive_file_id: 'samefile001', drive_modified_at: '2026-10-30T10:00:00Z' }, { id: 'b', drive_file_id: 'editedfile1', drive_modified_at: '2026-10-30T10:00:00Z' }, { id: 'c', drive_file_id: null, drive_modified_at: null }],
  )
  assert.deepEqual(plan.add.map(f => f.id), ['newfile0001'])
  assert.deepEqual(plan.refresh.map(r => [r.file.id, r.itemId]), [['editedfile1', 'b']])
  assert.equal(plan.unchanged, 1)
  assert.deepEqual(plan.unsupported, ['notes000001.png'])
})

test('sample names drop the extension and control characters', () => {
  assert.equal(sampleName('BF_offer_01.final.png'), 'BF_offer_01.final')
  assert.equal(sampleName('.png'), 'Sample')
})
