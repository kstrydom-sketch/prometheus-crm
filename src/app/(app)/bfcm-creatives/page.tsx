import Link from 'next/link'
import { parsePlanConfig } from '@/lib/bfcm/content'
import { listStaffPlans } from '@/lib/bfcm/server'

export const dynamic = 'force-dynamic'
export default async function BfcmCreativesPage() {
  const { plans, unavailable } = await listStaffPlans()
  const configured = plans.flatMap(plan => { const config = parsePlanConfig(plan.config, plan.slug); return config ? [{ plan, brand: config.brand }] : [] })
  const totalCap = configured.reduce((sum, item) => sum + item.brand.cap, 0)
  return <main style={{ padding: '40px clamp(20px,4vw,64px)', maxWidth: 1400, margin: 'auto' }}>
    <p style={{ color: '#00E4E6', fontSize: 12, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>2026</p>
    <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-.03em', margin: '10px 0' }}>BFCM Creatives</h1>
    <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>{configured.length} brands · {totalCap.toLocaleString('en-US')} creatives</p>
    {unavailable && <div role="alert" className="card" style={{ marginBottom: 24 }}>Unable to load plans. Try again.</div>}
    {!unavailable && configured.length === 0 && <p>No plans.</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 20 }}>
      {configured.map(({ brand, plan }) => {
        const locked = (plan?.state as { status?: string } | null)?.status === 'locked'
        return <Link key={brand.slug} href={`/bfcm-creatives/${brand.slug}`} className="card" style={{ display: 'block', padding: 26, textDecoration: 'none', color: 'var(--text-primary)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{locked ? 'Plan locked' : plan?.version ? 'In progress' : 'Ready to start'}</span><span aria-hidden="true">↗</span></div>
          <h2 style={{ fontSize: 22, fontWeight: 700, margin: '24px 0 8px' }}>{brand.name}</h2>
          <p style={{ fontSize: 28, fontWeight: 750 }}>{brand.cap} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-secondary)' }}>creatives</span></p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 18 }}>{brand.contract.kind === 'exact' ? 'Contracted category mix' : brand.contract.kind === 'grouped' ? `${brand.contract.static} statics · ${brand.contract.motion} motion` : 'Flexible mix · adjustable suggestion'}</p>
        </Link>
      })}
    </div>
  </main>
}
