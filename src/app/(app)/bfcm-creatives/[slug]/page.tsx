import { listBfcmFiles, prepareBfcmFileUpload, finalizeBfcmFileUpload, removeBfcmFile, getBfcmFileDownload, cleanupBfcmExpiredUploads } from '@/lib/bfcm/files'
import { planMotionReferences } from '@/lib/bfcm/content'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import BfcmAccess from '@/components/bfcm/BfcmAccess'
import BfcmPlanner from '@/components/bfcm/BfcmPlanner'
import { loadPlan, requireBfcmEditor } from '@/lib/bfcm/server'
import { saveStaffBfcmPlan } from '@/lib/bfcm/actions'
import BfcmProduction from '@/components/bfcm/BfcmProduction'
import { productionCounts } from '@/lib/bfcm/production'
import { loadProductionSteps } from '@/lib/bfcm/production-server'
import { getCachedProfiles } from '@/lib/profiles'
import { easternToday } from '@/lib/eastern'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export default async function BfcmPlanPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireBfcmEditor()
  const { slug } = await params
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) notFound()
  let loaded
  try { loaded = await loadPlan(slug) } catch {
    return <main style={{ padding: 40 }}><h1>BFCM Creatives</h1><p role="alert">Unable to load this plan. BFCM storage must be available before editing.</p><Link href="/bfcm-creatives">Back to brands</Link></main>
  }
  const fileAccess = { slug }
  const files = await listBfcmFiles(fileAccess)
  const [production, profiles] = await Promise.all([loadProductionSteps(slug), getCachedProfiles()])
  const people = profiles.filter(p => p.can_edit).map(p => ({ id: p.id, name: p.full_name || p.email }))
  const fileActions = { prepare: prepareBfcmFileUpload.bind(null, fileAccess), finalize: finalizeBfcmFileUpload.bind(null, fileAccess), remove: removeBfcmFile.bind(null, fileAccess), download: getBfcmFileDownload.bind(null, fileAccess), cleanup: cleanupBfcmExpiredUploads.bind(null, fileAccess) }
  return <><BfcmAccess slug={slug} /><BfcmProduction slug={slug} steps={production.ok ? production.steps : null} people={people} counts={productionCounts(loaded.draft.allocation)} today={easternToday()} /><BfcmPlanner brand={loaded.brand} initialFiles={files.ok ? files.files : []} initialFilesError={files.ok ? undefined : files.error} fileActions={fileActions} initialDraft={loaded.draft} initialVersion={loaded.row.version} saveAction={saveStaffBfcmPlan.bind(null, slug)} motionReferences={planMotionReferences(loaded.config)} sourceNotice={loaded.config.sourceNotice} /></>
}
