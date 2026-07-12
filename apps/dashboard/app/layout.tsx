import type { Metadata } from 'next';
import { Nunito } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NavLinks } from './nav-links';
import './globals.css';

const nunito = Nunito({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'sower',
  description: 'sower application task dashboard',
  icons: {
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌱</text></svg>',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={nunito.variable}>
      <body>
        <div className="shell">
          <header className="site-header">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                🌱
              </span>
              sower
            </Link>
            <NavLinks />
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
