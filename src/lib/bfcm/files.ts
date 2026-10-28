'use server'

import { createHash, randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { loadPlan, requireBfcmEditor, resolveClientPlan } from './server'
import type { Draft } from './model'

export type BfcmFileAccess = { slug: string; token?: never } | { token: string; slug?: never }
export type BfcmFile = { id: string; name: string; size: number; contentType: string; createdAt: string }
type Failure = { ok: false; error: string }
type FilesResult = { ok: true; files: BfcmFile[] } | Failure
type MutationResult = { ok: true; version: number; draft: Draft; files: BfcmFile[] } | Failure
type FileRow = { id: string; plan_slug: string; storage_path: string; file_name: string; content_type: string; byte_size: number; status: string; created_at: string; expires_at: string; attached_version: number | null; removed_version: number | null }
const BUCKET = 'bfcm-files'
const MAX_BYTES = 250 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLUMNS = 'id,plan_slug,storage_path,file_name,content_type,byte_size,status,created_at,expires_at,attached_version,removed_version'

async function authorize(access: BfcmFileAccess) {
  if (!access || typeof access !== 'object' || ('slug' in access) === ('token' in access)) throw new Error('Invalid file access request.')
  if ('token' in access) {
    if (typeof access.token !== 'string') throw new Error('Invalid file access request.')
    const resolved = await resolveClientPlan(access.token)
    if (!resolved) throw new Error('Invalid or revoked plan link.')
    return { ...resolved, digest: createHash('sha256').update(access.token).digest('hex') }
  }
  await requireBfcmEditor()
  if (typeof access.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(access.slug)) throw new Error('Invalid plan.')
  return { slug: access.slug, client: createServiceClient(), digest: null }
}
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('BFCM_CONFLICT')) return 'This plan changed in another session. Reload before changing files.'
  if (message.includes('BFCM_LOCKED')) return 'Reopen the plan before changing files.'
  if (message.includes('BFCM_FILE_QUOTA')) return 'This plan has reached its 20-file or 1 GiB storage limit. Each pending upload reserves 250 MiB until finalized or explicitly cleared after expiry. Retained version files also count toward the limit.'
  if (message.includes('BFCM_UPLOAD_EXPIRED')) return 'This upload has expired. Start a new upload.'
  if (message.includes('BFCM_FILE_BYTES_MISMATCH')) return 'The uploaded file does not match its reserved size or type. Upload the file again.'
  if (message.startsWith('BFCM_')) return 'Unable to change this file. Reload the plan and try again.'
  return message || 'Unable to access plan files. Try again.'
}
function metadata(input: { fileName: string; contentType: string; byteSize: number }) {
  if (!input || typeof input.fileName !== 'string' || !input.fileName.trim() || typeof input.contentType !== 'string') throw new Error('Invalid file metadata.')
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > MAX_BYTES) throw new Error('Choose a nonempty file no larger than 250 MiB.')
  const name = input.fileName.replace(/[\\/\u0000-\u001f\u007f"\u202a-\u202e\u2066-\u2069]+/g, '_').trim().slice(0, 180)
  const contentType = input.contentType || 'application/octet-stream'
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType) || contentType.length > 150) throw new Error('Invalid file type.')
  return { name, contentType, size: input.byteSize }
}
function mapFile(row: FileRow): BfcmFile { return { id: row.id, name: row.file_name, size: row.byte_size, contentType: row.content_type, createdAt: row.created_at } }
async function readFiles(auth: Awaited<ReturnType<typeof authorize>>) {
  const { data, error } = await auth.client.from('bfcm_plan_files').select(COLUMNS).eq('plan_slug', auth.slug).eq('status', 'active').order('created_at', { ascending: true })
  if (error) throw new Error('Plan files are not available yet.')
  return ((data ?? []) as FileRow[]).map(mapFile)
}
async function currentPlan(auth: Awaited<ReturnType<typeof authorize>>, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid plan version.')
  const plan = await loadPlan(auth.slug, auth.client)
  if (plan.row.version !== expectedVersion) throw new Error('BFCM_CONFLICT')
  if (plan.draft.status === 'locked') throw new Error('BFCM_LOCKED')
  return plan
}

export async function listBfcmFiles(access: BfcmFileAccess): Promise<FilesResult> {
  try { const auth = await authorize(access); return { ok: true, files: await readFiles(auth) } }
  catch (error) { return { ok: false, error: errorMessage(error) } }
}

export async function prepareBfcmFileUpload(access: BfcmFileAccess, input: { fileName: string; contentType: string; byteSize: number }, expectedVersion: number): Promise<{ ok: true; id: string; path: string; token: string; bucket: string; contentType: string } | Failure> {
  try {
    const auth = await authorize(access)
    await currentPlan(auth, expectedVersion)
    const file = metadata(input), id = randomUUID(), path = `${auth.slug}/${id}`
    const { error: reservationError } = await auth.client.rpc('bfcm_file_change', { p_slug: auth.slug, p_expected_version: expectedVersion, p_operation: 'reserve', p_id: id, p_file_name: file.name, p_content_type: file.contentType, p_byte_size: file.size, p_access_token_hash: auth.digest })
    if (reservationError) throw new Error(reservationError.message)
    // Supabase signed upload tokens last two hours; reservation cleanup waits 130 minutes.
    // Every file is opaque binary, never rendered inline, and cannot overwrite a prior object.
    const { data, error } = await auth.client.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false })
    if (error || !data) throw new Error('Unable to start the upload. Its reservation will expire automatically; expired uploads can be cleared from this plan.')
    return { ok: true, id, path: data.path, token: data.token, bucket: BUCKET, contentType: 'application/octet-stream' }
  } catch (error) { return { ok: false, error: errorMessage(error) } }
}

async function mutateFile(access: BfcmFileAccess, id: string, expectedVersion: number, operation: 'finalize' | 'remove'): Promise<MutationResult> {
  try {
    const auth = await authorize(access)
    if (!UUID.test(id)) throw new Error('Invalid file.')
    const before = await currentPlan(auth, expectedVersion)
    const { error } = await auth.client.rpc('bfcm_file_change', { p_slug: auth.slug, p_expected_version: expectedVersion, p_operation: operation, p_id: id, p_access_token_hash: auth.digest, p_state: before.draft })
    if (error) throw new Error(error.message)
    const saved = await loadPlan(auth.slug, auth.client)
    revalidatePath('/bfcm-creatives')
    return { ok: true, version: saved.row.version, draft: saved.draft, files: await readFiles(auth) }
  } catch (error) { return { ok: false, error: errorMessage(error) } }
}
export async function finalizeBfcmFileUpload(access: BfcmFileAccess, id: string, expectedVersion: number): Promise<MutationResult> { return mutateFile(access, id, expectedVersion, 'finalize') }
export async function removeBfcmFile(access: BfcmFileAccess, id: string, expectedVersion: number): Promise<MutationResult> { return mutateFile(access, id, expectedVersion, 'remove') }

export async function getBfcmFileDownload(access: BfcmFileAccess, id: string): Promise<{ ok: true; url: string } | Failure> {
  try {
    const auth = await authorize(access)
    if (!UUID.test(id)) throw new Error('Invalid file.')
    // Removed files remain downloadable to this plan's authorized users for old version references.
    const { data, error } = await auth.client.from('bfcm_plan_files').select(COLUMNS).eq('id', id).eq('plan_slug', auth.slug).in('status', ['active', 'removed']).single()
    if (error || !data) throw new Error('This file is unavailable.')
    const file = data as FileRow
    if (file.storage_path !== `${auth.slug}/${file.id}`) throw new Error('Invalid file path.')
    const downloadName = file.file_name.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\/]/g, '_')
    const signed = await auth.client.storage.from(BUCKET).createSignedUrl(file.storage_path, 60, { download: downloadName })
    if (signed.error || !signed.data) throw new Error('Unable to create a download link.')
    return { ok: true, url: signed.data.signedUrl }
  } catch (error) { return { ok: false, error: errorMessage(error) } }
}

/** Explicit plan-scoped cleanup, not a cron or a bucket-wide scan. Never touches active/historical files. */
export async function cleanupBfcmExpiredUploads(access: BfcmFileAccess, expectedVersion: number): Promise<{ ok: true; cleaned: number } | Failure> {
  try {
    const auth = await authorize(access)
    await currentPlan(auth, expectedVersion)
    const { data, error } = await auth.client.from('bfcm_plan_files').select(COLUMNS).eq('plan_slug', auth.slug).in('status', ['pending', 'expired']).lt('expires_at', new Date().toISOString()).limit(20)
    if (error) throw new Error('Unable to check expired uploads.')
    let cleaned = 0
    for (const file of (data ?? []) as FileRow[]) {
      if (file.storage_path !== `${auth.slug}/${file.id}` || !UUID.test(file.id)) continue
      const args = { p_slug: auth.slug, p_expected_version: expectedVersion, p_id: file.id, p_access_token_hash: auth.digest }
      const expired = await auth.client.rpc('bfcm_file_change', { ...args, p_operation: 'expire' })
      if (expired.error) throw new Error(expired.error.message)
      const removed = await auth.client.storage.from(BUCKET).remove([file.storage_path])
      if (removed.error) throw new Error('Some expired uploads could not be cleared. Try again; active and historical files were not changed.')
      const purged = await auth.client.rpc('bfcm_file_change', { ...args, p_operation: 'purge' })
      if (purged.error) throw new Error(purged.error.message)
      cleaned++
    }
    return { ok: true, cleaned }
  } catch (error) { return { ok: false, error: errorMessage(error) } }
}
