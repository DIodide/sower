import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'sower',
  description: 'sower application task dashboard',
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
            maxWidth: '64rem',
            margin: '0 auto',
            padding: '2rem 1.5rem',
          }}
        >
          <h1
            style={{
              fontSize: '1.25rem',
              fontWeight: 600,
              letterSpacing: '0.02em',
              marginBottom: '1.5rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            sower
          </h1>
          {children}
        </main>
      </body>
    </html>
  );
}
