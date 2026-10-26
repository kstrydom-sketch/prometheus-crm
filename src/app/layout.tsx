import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import "./prototype-theme.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Prometheus CRM",
  description: "Common Thread Collective — Prometheus Project Studio",
};

// Prototype: light only. The class is rendered on <html> below, and this keeps
// it there even if an old 'dark' preference is still in localStorage.
const themeInitScript = `(function() {
  document.documentElement.classList.add('theme-light');
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full theme-light`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
