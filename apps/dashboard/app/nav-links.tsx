'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Tasks' },
  { href: '/ingestion', label: 'Ingestion' },
  { href: '/answers', label: 'Answers' },
  { href: '/platforms', label: 'Platforms' },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === '/') {
    // Task detail pages live under /tasks; the home list owns both.
    return pathname === '/' || pathname.startsWith('/tasks');
  }
  // /platforms also owns the /tenants drill-down pages.
  if (href === '/platforms') {
    return pathname.startsWith('/platforms') || pathname.startsWith('/tenants');
  }
  return pathname.startsWith(href);
}

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="primary">
      {LINKS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href, pathname) ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
