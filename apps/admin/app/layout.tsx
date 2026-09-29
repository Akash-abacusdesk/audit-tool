import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import Providers from '@/components/Providers';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'DevSecOps console',
  description: 'Sites, the team that runs them, and every scan, finding and access request in one place.',
};

// Fixed, non-interactive atmosphere: two soft light pools and a faint film grain (blend only, never over content).
const GLOW =
  'bg-[radial-gradient(52rem_34rem_at_8%_-12%,oklch(0.8_0.15_162/0.09),transparent_62%),radial-gradient(44rem_28rem_at_100%_0%,oklch(0.72_0.04_250/0.07),transparent_60%)]';
const GRAIN =
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")]";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} [color-scheme:dark]`}>
      {/* Browser extensions (Grammarly etc.) add attributes to <body> before hydration; that is not a bug in the page. */}
      <body className="min-h-dvh bg-canvas font-sans text-sm leading-6 text-ink antialiased selection:bg-accent/30" suppressHydrationWarning>
        <div aria-hidden className={`pointer-events-none fixed inset-0 -z-10 ${GLOW}`} />
        <div aria-hidden className={`pointer-events-none fixed inset-0 -z-10 opacity-[0.04] mix-blend-overlay ${GRAIN}`} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
