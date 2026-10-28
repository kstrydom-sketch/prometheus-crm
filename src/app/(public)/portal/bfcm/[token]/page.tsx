import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import BfcmPlanner from '@/components/bfcm/BfcmPlanner'
import { loadPlan, resolveClientPlan } from '@/lib/bfcm/server'
import { saveClientBfcmPlan } from '@/lib/bfcm/actions'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const metadata: Metadata = { title: 'BFCM Plan', robots: { index: false, follow: false }, referrer: 'no-referrer' }
export default async function ClientBfcmPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const resolved = await resolveClientPlan(token)
  if (!resolved) notFound()
  const loaded = await loadPlan(resolved.slug, resolved.client)
  return <BfcmPlanner brand={loaded.brand} initialDraft={loaded.draft} initialVersion={loaded.row.version} saveAction={saveClientBfcmPlan.bind(null, token)} motionReferences={loaded.config.motionReferences} sourceNotice={loaded.config.sourceNotice} backHref={`/portal/bfcm/${token}`} />
}
