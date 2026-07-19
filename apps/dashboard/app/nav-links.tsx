'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Three tabs: the two things a user actually does (Applications, Answers)
// and, set apart and muted, the machinery (System).
const LINKS = [
  { href: '/', label: 'Applications', secondary: false },
  { href: '/answers', label: 'Answers', secondary: false },
  { href: '/system', label: 'System', secondary: true },
] as const;

function isActive(href: string, pathname: string): boolean {
  if (href === '/') {
    // Task detail pages live under /tasks; the Applications workspace owns
    // both (and the old /queue redirect).
    return (
      pathname === '/' ||
      pathname.startsWith('/tasks') ||
      pathname.startsWith('/queue')
    );
  }
  if (href === '/system') {
    // /system also owns the platform/tenant drill-downs and the old ops URLs.
    return (
      pathname.startsWith('/system') ||
      pathname.startsWith('/platforms') ||
      pathname.startsWith('/tenants') ||
      pathname.startsWith('/ingestion') ||
      pathname.startsWith('/sessions')
    );
  }
  return pathname.startsWith(href);
}

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="primary">
      {LINKS.map(({ href, label, secondary }) => (
        <Link
          key={href}
          href={href}
          className={secondary ? 'nav-secondary' : undefined}
          aria-current={isActive(href, pathname) ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
