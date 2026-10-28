import { Inter } from 'next/font/google'
const inter = Inter({ subsets: ['latin'], variable: '--font-bfcm-inter' })
export default function BfcmFrame({ children }: { children: React.ReactNode }) {
  return <div lang="en" className={inter.variable} style={{ fontFamily: 'var(--font-bfcm-inter), sans-serif' }}>{children}</div>
}
