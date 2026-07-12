import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'sower',
  description: 'sower application task dashboard',
};

const navLinkStyle: CSSProperties = {
  color: '#8b93a7',
  textDecoration: 'none',
  fontSize: '0.875rem',
  letterSpacing: '0.02em',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          backgroundColor: '#0b0e14',
          color: '#d7dae0',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          minHeight: '100vh',
        }}
      >
        <main
          style={{
            maxWidth: '72rem',
            margin: '0 auto',
            padding: '2rem 1.5rem',
          }}
        >
          <header
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '1.5rem',
              borderBottom: '1px solid #1c2130',
              paddingBottom: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            <Link
              href="/"
              style={{
                fontSize: '1.25rem',
                fontWeight: 600,
                letterSpacing: '0.02em',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: '#d7dae0',
                textDecoration: 'none',
              }}
            >
              sower
            </Link>
            <nav style={{ display: 'flex', gap: '1.25rem' }}>
              <Link href="/" style={navLinkStyle}>
                Tasks
              </Link>
              <Link href="/platforms" style={navLinkStyle}>
                Platforms
              </Link>
            </nav>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
}
