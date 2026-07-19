'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Flat hairline sub-navigation for the Answers area: the answer library
// (this area's home), the resolution profile, and the resume workspace.
// Mirrors the site nav's underline treatment at one size smaller.
const LINKS = [
  { href: '/answers', label: 'Answers', exact: true },
  { href: '/answers/profile', label: 'Profile', exact: false },
  { href: '/answers/resumes', label: 'Resumes', exact: false },
] as const;

export function AnswersSubnav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="answers sections"
      style={{
        display: 'flex',
        gap: '1rem',
        borderBottom: '1px solid var(--line)',
        margin: '0 0 1rem',
      }}
    >
      {LINKS.map(({ href, label, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            style={{
              padding: '0.25rem 0.125rem 0.3125rem',
              marginBottom: '-1px',
              fontSize: '0.8125rem',
              fontWeight: 500,
              color: active ? 'var(--ink)' : 'var(--ink-muted)',
              borderBottom: active
                ? '2px solid var(--accent)'
                : '2px solid transparent',
              textDecoration: 'none',
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
