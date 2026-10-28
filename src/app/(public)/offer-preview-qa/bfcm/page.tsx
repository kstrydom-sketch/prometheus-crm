import { notFound } from 'next/navigation'
import BfcmFixture from '@/components/bfcm/BfcmFixture'

export const dynamic = 'force-dynamic'
export default function BfcmPreviewFixturePage() {
  // Fictional UI fixture only; never a production auth bypass or live data path.
  if (process.env.VERCEL_ENV !== 'preview' && process.env.NODE_ENV !== 'development') notFound()
  return <BfcmFixture />
}
