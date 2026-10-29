'use server'

import { randomBytes, randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { createNotifications } from '@/lib/notifications'
import { downloadDriveFile, extractDriveFolderId, listDriveFolder } from '@/lib/drive'
import { requireStaffProfile } from './production-server'
import { CALIBRATION_BUCKET, MAX_SAMPLE_IMAGE_BYTES, MAX_SAMPLE_VIDEO_BYTES, copyDriveSample, planDriveSync, sampleExtension, sampleKind } from './calibration-drive'

type Result = { ok: true } | { ok: false; error: string }
const validSlug = (slug: unknown): slug is string => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const validToken = (token: unknown): token is string => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
const folder = (slug: string) => `bfcm-calibration/${slug}/`

function refresh(slug: string, token?: string) {
  revalidatePath(`/bfcm-creatives/${slug}`)
  revalidatePath('/bfcm-creatives')
  if (token) revalidatePath(`/review/bfcm/${token}`)
}
async function staff(slug: string, body: (me: { id: string | null; name: string }) => Promise<Result>): Promise<Result> {
  try {
    const me = await requireStaffProfile()
    if (!validSlug(slug)) return { ok: false, error: 'Invalid plan.' }
    return await body(me)
  } catch (error) {
    console.error('[bfcm calibration]', error)
    return { ok: false, error: error instanceof Error && error.message === 'Unauthorized access.' ? 'You need CRM access to do that.' : 'Something went wrong. Reload and try again.' }
  }
}
async function calibrationOf(slug: string) {
  const { data } = await createServiceClient().from('bfcm_calibrations').select('plan_slug,share_token,status').eq('plan_slug', slug).maybeSingle()
  return data as { plan_slug: string; share_token: string; status: string } | null
}
/** The top-level samples task, whose status follows the calibration round. */
async function setSamplesStatus(slug: string, status: 'waiting_client' | 'done' | 'in_progress') {
  const db = createServiceClient()
  const { data } = await db.from('bfcm_production_steps').select('id').eq('plan_slug', slug).eq('kind', 'samples').is('parent_id', null).maybeSingle()
  if (!data) return null
  const { count } = await db.from('bfcm_production_steps').select('id', { count: 'exact', head: true }).eq('parent_id', data.id)
  if (!count) await db.from('bfcm_production_steps').update({ status, updated_at: new Date().toISOString() }).eq('id', data.id)
  return data.id as string
}

/** Creates this brand's calibration round (and its client link) if it doesn't exist yet. */
export async function startCalibration(slug: string): Promise<Result> {
  return staff(slug, async () => {
    const { data: plan } = await createServiceClient().from('bfcm_plans').select('slug').eq('slug', slug).maybeSingle()
    if (!plan) return { ok: false, error: 'Plan not found.' }
    if (!await calibrationOf(slug)) {
      const { error } = await createServiceClient().from('bfcm_calibrations').insert({ plan_slug: slug, share_token: randomBytes(32).toString('hex') })
      if (error && !await calibrationOf(slug)) return { ok: false, error: 'Unable to start calibration.' }
    }
    refresh(slug)
    return { ok: true }
  })
}

/**
 * First half of an upload: a signed URL the browser uploads straight to.
 * Same two-step flow as brand documents, since a Server Action body is capped at 1MB.
 */
export async function createCalibrationUploadUrl(slug: string, contentType: string, byteSize: number): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  let out: { ok: true; path: string; token: string } | { ok: false; error: string } = { ok: false, error: 'Unable to start the upload.' }
  const result = await staff(slug, async () => {
    const cal = await calibrationOf(slug)
    if (!cal) return { ok: false, error: 'Start calibration first.' }
    if (cal.status === 'submitted') return { ok: false, error: 'The client already submitted feedback. Reopen the round to change samples.' }
    const ext = sampleExtension(contentType)
    if (!ext) return { ok: false, error: 'Samples can be JPG, PNG, WebP, GIF, MP4, MOV or WebM.' }
    const limit = sampleKind(contentType) === 'image' ? MAX_SAMPLE_IMAGE_BYTES : MAX_SAMPLE_VIDEO_BYTES
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > limit) return { ok: false, error: `Files can be up to ${limit / 1048576}MB.` }
    const { data, error } = await createServiceClient().storage.from(CALIBRATION_BUCKET).createSignedUploadUrl(`${folder(slug)}${randomUUID()}.${ext}`)
    if (error || !data) return { ok: false, error: 'Unable to start the upload.' }
    out = { ok: true, path: data.path, token: data.token }
    return { ok: true }
  })
  return result.ok ? out : result
}

/** Second half: the bytes are in Storage, so this records them as a sample. */
export async function attachCalibrationItem(slug: string, path: string, name: string, contentType: string): Promise<Result> {
  return staff(slug, async me => {
    const cal = await calibrationOf(slug)
    if (!cal || cal.status === 'submitted') return { ok: false, error: 'This round can’t take new samples.' }
    const file = typeof path === 'string' && path.startsWith(folder(slug)) ? path.slice(folder(slug).length) : ''
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(file)) return { ok: false, error: 'That upload does not belong to this brand.' }
    const mediaType = sampleKind(contentType)
    if (!mediaType) return { ok: false, error: 'That file type is not accepted.' }
    const db = createServiceClient()
    const { data: listed } = await db.storage.from(CALIBRATION_BUCKET).list(folder(slug).slice(0, -1), { search: file })
    if (!listed?.some(o => o.name === file)) return { ok: false, error: 'The upload didn’t finish. Try again.' }
    const { data: last } = await db.from('bfcm_calibration_items').select('sort_order').eq('plan_slug', slug).order('sort_order', { ascending: false }).limit(1)
    const clean = (typeof name === 'string' ? name : '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || file
    const { error } = await db.from('bfcm_calibration_items').insert({ plan_slug: slug, storage_path: path, name: clean, media_type: mediaType, sort_order: ((last?.[0]?.sort_order as number | undefined) ?? 0) + 1, uploaded_by: me.id })
    if (error) return { ok: false, error: 'Unable to add the sample.' }
    refresh(slug, cal.share_token)
    return { ok: true }
  })
}

export async function removeCalibrationItem(slug: string, id: string): Promise<Result> {
  return staff(slug, async () => {
    const cal = await calibrationOf(slug)
    if (!cal || cal.status === 'submitted') return { ok: false, error: 'Reopen the round before removing samples.' }
    if (!validId(id)) return { ok: false, error: 'Invalid sample.' }
    const db = createServiceClient()
    const { data } = await db.from('bfcm_calibration_items').delete().eq('id', id).eq('plan_slug', slug).select('storage_path')
    if (data?.[0]) await db.storage.from(CALIBRATION_BUCKET).remove([data[0].storage_path as string])
    refresh(slug, cal.share_token)
    return { ok: true }
  })
}

/**
 * Saves the team's Drive folder and works out what to copy: new files, and files
 * edited since they were copied. The browser then copies them one at a time with
 * copyCalibrationDriveFile, so a folder of large videos never hits one request's time limit.
 */
export async function syncCalibrationFolder(slug: string, folderUrl: string): Promise<{ ok: true; files: { id: string; name: string }[]; unchanged: number; unsupported: string[] } | { ok: false; error: string }> {
  let out: { ok: true; files: { id: string; name: string }[]; unchanged: number; unsupported: string[] } | null = null
  const result = await staff(slug, async () => {
    const cal = await calibrationOf(slug)
    if (!cal) return { ok: false, error: 'Start calibration first.' }
    if (cal.status === 'submitted') return { ok: false, error: 'The client already submitted feedback. Reopen the round to change samples.' }
    const url = typeof folderUrl === 'string' ? folderUrl.trim() : ''
    let folderId: string
    try { folderId = extractDriveFolderId(url) } catch { return { ok: false, error: 'Paste a Drive folder link (drive.google.com/drive/folders/…).' } }
    if (url.length > 500) return { ok: false, error: 'That link is too long.' }
    let listed
    try { listed = await listDriveFolder(folderId) } catch (e) {
      console.error('[bfcm calibration drive]', e)
      return { ok: false, error: 'Couldn’t open that folder. Check the link, and that the folder is shared with the CRM’s Drive account like Moments folders are.' }
    }
    const db = createServiceClient()
    await db.from('bfcm_calibrations').update({ drive_folder_url: url }).eq('plan_slug', slug)
    if (!listed.length) { refresh(slug); return { ok: false, error: 'That folder has no images or videos we can see. Nothing was changed: check the link and that the folder is shared with the CRM.' } }
    const { data: existing } = await db.from('bfcm_calibration_items').select('id,drive_file_id,drive_modified_at').eq('plan_slug', slug)
    const plan = planDriveSync(listed, existing ?? [])
    out = { ok: true, files: [...plan.add, ...plan.refresh.map(r => r.file)].map(f => ({ id: f.id, name: f.name })), unchanged: plan.unchanged, unsupported: plan.unsupported }
    refresh(slug)
    return { ok: true }
  })
  return result.ok && out ? out : result as { ok: false; error: string }
}

/** Copies one file from the saved folder (re-listed here, so only files really in that folder can be copied). */
export async function copyCalibrationDriveFile(slug: string, fileId: string): Promise<Result> {
  return staff(slug, async me => {
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return { ok: false, error: 'Invalid file.' }
    const db = createServiceClient()
    const { data: cal } = await db.from('bfcm_calibrations').select('status,share_token,drive_folder_url').eq('plan_slug', slug).maybeSingle()
    if (!cal?.drive_folder_url) return { ok: false, error: 'Sync the folder first.' }
    if (cal.status === 'submitted') return { ok: false, error: 'The client already submitted feedback.' }
    const file = (await listDriveFolder(extractDriveFolderId(cal.drive_folder_url))).find(f => f.id === fileId)
    if (!file) return { ok: false, error: 'That file is no longer in the folder.' }
    const { data: existing } = await db.from('bfcm_calibration_items').select('id,drive_file_id,drive_modified_at').eq('plan_slug', slug).eq('drive_file_id', fileId).maybeSingle()
    if (existing && existing.drive_modified_at === (file.modifiedTime ?? null)) return { ok: true }
    const copied = await copyDriveSample(db, slug, file, existing?.id ?? null, downloadDriveFile, me.id)
    if (!copied.ok) return { ok: false, error: copied.message }
    refresh(slug, cal.share_token as string)
    return { ok: true }
  })
}

/** Opens the client link. The samples task moves to "Waiting on client". */
export async function sendCalibration(slug: string): Promise<Result> {
  return staff(slug, async () => {
    const cal = await calibrationOf(slug)
    if (!cal) return { ok: false, error: 'Start calibration first.' }
    if (cal.status !== 'draft') return { ok: true }
    const db = createServiceClient()
    const { count } = await db.from('bfcm_calibration_items').select('id', { count: 'exact', head: true }).eq('plan_slug', slug)
    if (!count) return { ok: false, error: 'Add at least one sample before sending.' }
    const { error } = await db.from('bfcm_calibrations').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('plan_slug', slug).eq('status', 'draft')
    if (error) return { ok: false, error: 'Unable to open the link.' }
    await setSamplesStatus(slug, 'waiting_client')
    refresh(slug, cal.share_token)
    return { ok: true }
  })
}

/** "sent" → "draft" hides the samples from the client again; "submitted" → "sent" lets them change their feedback. */
export async function reopenCalibration(slug: string, to: 'draft' | 'sent'): Promise<Result> {
  return staff(slug, async () => {
    const cal = await calibrationOf(slug)
    const from = to === 'draft' ? 'sent' : 'submitted'
    if (!cal || cal.status !== from) return { ok: false, error: 'Reload: the round has changed.' }
    const patch = to === 'draft' ? { status: 'draft' } : { status: 'sent', submitted_at: null }
    const { error } = await createServiceClient().from('bfcm_calibrations').update(patch).eq('plan_slug', slug).eq('status', from)
    if (error) return { ok: false, error: 'Unable to update the round.' }
    await setSamplesStatus(slug, to === 'draft' ? 'in_progress' : 'waiting_client')
    refresh(slug, cal.share_token)
    return { ok: true }
  })
}

// ── Client side: the token is the only key, and it only reaches one brand's open round ──

async function openRound(token: string) {
  if (!validToken(token)) return null
  const { data } = await createServiceClient().from('bfcm_calibrations').select('plan_slug,share_token,status').eq('share_token', token).maybeSingle()
  return data && data.status === 'sent' ? data as { plan_slug: string; share_token: string; status: string } : null
}
async function itemOf(slug: string, id: unknown) {
  if (!validId(id)) return null
  const { data } = await createServiceClient().from('bfcm_calibration_items').select('id').eq('id', id).eq('plan_slug', slug).maybeSingle()
  return data
}
const closed: Result = { ok: false, error: 'This review is closed. Contact the team if you need to change anything.' }

export async function clientSetSampleStatus(token: string, itemId: string, status: 'pending' | 'approved' | 'needs_changes'): Promise<Result> {
  try {
    const round = await openRound(token)
    if (!round) return closed
    if (!['pending', 'approved', 'needs_changes'].includes(status) || !await itemOf(round.plan_slug, itemId)) return { ok: false, error: 'Invalid sample.' }
    const { error } = await createServiceClient().from('bfcm_calibration_items').update({ client_status: status }).eq('id', itemId)
    if (error) return { ok: false, error: 'Couldn’t save. Please try again.' }
    refresh(round.plan_slug, token)
    return { ok: true }
  } catch { return { ok: false, error: 'Couldn’t save. Please try again.' } }
}

export async function clientAddSampleFeedback(token: string, itemId: string, name: string, body: string, pin: { x: number; y: number } | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const round = await openRound(token)
    if (!round) return closed as { ok: false; error: string }
    const text = typeof body === 'string' ? body.trim() : ''
    const author = (typeof name === 'string' ? name.trim() : '').slice(0, 120) || 'Client'
    if (!text || text.length > 5000) return { ok: false, error: 'Write your feedback (up to 5,000 characters).' }
    const inRange = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100
    if (pin && (!inRange(pin.x) || !inRange(pin.y))) return { ok: false, error: 'Invalid pin.' }
    if (!await itemOf(round.plan_slug, itemId)) return { ok: false, error: 'Invalid sample.' }
    const { data, error } = await createServiceClient().from('bfcm_calibration_feedback')
      .insert({ item_id: itemId, author_name: author, body: text, pin_x: pin?.x ?? null, pin_y: pin?.y ?? null }).select('id').single()
    if (error || !data) return { ok: false, error: 'Couldn’t post your comment. Please try again.' }
    refresh(round.plan_slug, token)
    return { ok: true, id: data.id }
  } catch { return { ok: false, error: 'Couldn’t post your comment. Please try again.' } }
}

/** The client confirms their feedback. The round closes and the team is notified. */
export async function clientSubmitCalibration(token: string, name: string, note: string): Promise<Result> {
  try {
    const round = await openRound(token)
    if (!round) return closed
    const author = (typeof name === 'string' ? name.trim() : '').slice(0, 120) || 'Client'
    const clientNote = (typeof note === 'string' ? note.trim() : '').slice(0, 5000) || null
    const db = createServiceClient()
    const { data, error } = await db.from('bfcm_calibrations')
      .update({ status: 'submitted', submitted_at: new Date().toISOString(), submitted_by_name: author, client_note: clientNote })
      .eq('plan_slug', round.plan_slug).eq('status', 'sent').select('plan_slug')
    if (error || !data?.length) return closed
    const stepId = await setSamplesStatus(round.plan_slug, 'done')
    const [{ data: plan }, { data: assignees }] = await Promise.all([
      db.from('bfcm_plans').select('brand_id,config').eq('slug', round.plan_slug).maybeSingle(),
      stepId ? db.from('bfcm_step_assignees').select('profile_id').eq('step_id', stepId) : Promise.resolve({ data: [] as { profile_id: string }[] }),
    ])
    const brandName = (plan?.config as { brand?: { name?: string } } | null)?.brand?.name ?? round.plan_slug
    await createNotifications((assignees ?? []).map(a => ({
      recipient_id: a.profile_id as string, actor_label: author, type: 'client_feedback' as const, brand_id: (plan?.brand_id as string | null) ?? null,
      title: `${brandName} sent their calibration feedback`, body: clientNote?.slice(0, 140) ?? 'Open the samples to see their notes.',
      link: `/bfcm-creatives/${round.plan_slug}#calibration`,
    })))
    refresh(round.plan_slug, token)
    return { ok: true }
  } catch { return { ok: false, error: 'Couldn’t submit. Please try again.' } }
}
