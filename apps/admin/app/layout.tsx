import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import MotionProvider from '@/components/MotionProvider';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'DevSecOps Admin',
  description: 'Control-plane admin: findings, scans, JIT approvals, Telegram alerts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased"><MotionProvider>{children}</MotionProvider></body>
    </html>
  );
}
