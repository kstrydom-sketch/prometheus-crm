import type { Metadata } from 'next'
import BfcmFrame from '@/components/bfcm/BfcmFrame'
export const metadata: Metadata = { title: 'BFCM Preview', robots: { index: false, follow: false } }
export default function Layout({ children }: { children: React.ReactNode }) { return <BfcmFrame>{children}</BfcmFrame> }
