import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NavLinks } from './nav-links';
import './globals.css';

export const metadata: Metadata = {
  title: 'sower',
  description: 'sower application task dashboard',
  icons: {
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌱</text></svg>',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                🌱
              </span>
              sower
            </Link>
            <NavLinks />
          </div>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
