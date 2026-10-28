import Link from 'next/link'
import { notFound } from 'next/navigation'
import BfcmAccess from '@/components/bfcm/BfcmAccess'
import BfcmPlanner from '@/components/bfcm/BfcmPlanner'
import { loadPlan, requireBfcmEditor } from '@/lib/bfcm/server'
import { saveStaffBfcmPlan } from '@/lib/bfcm/actions'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export default async function BfcmPlanPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireBfcmEditor()
  const { slug } = await params
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) notFound()
  let loaded
  try { loaded = await loadPlan(slug) } catch {
    return <main style={{ padding: 40 }}><h1>BFCM Creatives</h1><p role="alert">Não foi possível carregar o plano. O armazenamento BFCM precisa estar disponível antes de editar.</p><Link href="/bfcm-creatives">Voltar às marcas</Link></main>
  }
  return <><BfcmAccess slug={slug} /><BfcmPlanner brand={loaded.brand} initialDraft={loaded.draft} initialVersion={loaded.row.version} saveAction={saveStaffBfcmPlan.bind(null, slug)} motionReferences={loaded.config.motionReferences} sourceNotice={loaded.config.sourceNotice} /></>
}
