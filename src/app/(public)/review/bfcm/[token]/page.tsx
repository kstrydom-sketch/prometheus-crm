import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import { loadCalibrationItems } from '@/lib/bfcm/production-server'
import BfcmCalibrationReview from '@/components/bfcm/BfcmCalibrationReview'
import BrandMark from '@/components/BrandMark'
import ThemeToggle from '@/components/ThemeToggle'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'BFCM samples', robots: { index: false, follow: false }, referrer: 'no-referrer' }

/** Client calibration: the token opens one brand's samples and nothing else. */
export default async function BfcmCalibrationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!/^[a-f0-9]{64}$/.test(token)) notFound()
  const db = createServiceClient()
  const { data: cal } = await db.from('bfcm_calibrations').select('plan_slug,status,submitted_by_name,submitted_at').eq('share_token', token).maybeSingle()
  if (!cal) notFound()
  const { data: plan } = await db.from('bfcm_plans').select('config').eq('slug', cal.plan_slug).maybeSingle()
  const brandName = (plan?.config as { brand?: { name?: string } } | null)?.brand?.name ?? 'Your brand'
  const ready = cal.status === 'sent' || cal.status === 'submitted'
  const { items, feedback } = ready ? await loadCalibrationItems(cal.plan_slug) : { items: [], feedback: [] }

  return <div style={{ minHeight: '100vh', background: 'var(--background)' }}>
    <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '0 var(--space-6)', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 50 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <BrandMark size={28} />
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>Prometheus</span>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginLeft: 2 }}>by CTC</span>
      </div>
      <ThemeToggle />
    </div>
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: 'var(--space-10) var(--space-4) 80px' }}>
      <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>{brandName} · Black Friday / Cyber Monday</p>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em', marginBottom: 'var(--space-4)' }}>Calibration samples</h1>
      {ready
        ? <BfcmCalibrationReview token={token} items={items} feedback={feedback} submitted={cal.status === 'submitted' ? { by: cal.submitted_by_name, at: cal.submitted_at } : null} />
        : <div className="card"><p style={{ margin: 0, color: 'var(--text-secondary)' }}>Your samples are being prepared. We’ll let you know when they’re ready to review.</p></div>}
    </main>
  </div>
}
