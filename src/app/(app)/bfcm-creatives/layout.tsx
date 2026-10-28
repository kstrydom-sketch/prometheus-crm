import type { Metadata } from 'next'
import BfcmFrame from '@/components/bfcm/BfcmFrame'
export const metadata: Metadata = { title: 'BFCM Creatives', description: 'Plan your Black Friday creative campaign.' }
export default function Layout({ children }: { children: React.ReactNode }) { return <BfcmFrame>{children}</BfcmFrame> }
