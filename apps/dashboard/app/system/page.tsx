// /system — the merged ops surface: ingest health, the local capture agent &
// Workday sessions, and the platform overview. The old /ingestion, /sessions,
// and /platforms routes redirect here; per-platform and tenant drill-downs
// stay at their own URLs, linked from the Platforms section. Each section
// streams in behind its own Suspense boundary so one slow query never blanks
// the whole page.
import { Suspense } from 'react';
import { Empty, SectionHeading } from '../../lib/ui';
import { IngestSection } from './ingest-section';
import { PlatformsSection } from './platforms-section';
import { SessionsSection } from './sessions-section';

export const dynamic = 'force-dynamic';

export default function SystemPage() {
  return (
    <div>
      <h1 className="page-title">System</h1>
      <p className="page-sub">
        The machinery behind the Applications list: what ingestion is pulling
        in, whether the local agent is alive, and the platforms sower talks to.
      </p>

      <section id="ingest-health">
        <SectionHeading>Ingest health</SectionHeading>
        <Suspense fallback={<Empty>loading ingest health…</Empty>}>
          <IngestSection />
        </Suspense>
      </section>

      <section id="sessions">
        <SectionHeading>Local agent &amp; Workday sessions</SectionHeading>
        <Suspense fallback={<Empty>loading sessions…</Empty>}>
          <SessionsSection />
        </Suspense>
      </section>

      <section id="platforms">
        <SectionHeading>Platforms</SectionHeading>
        <Suspense fallback={<Empty>loading platforms…</Empty>}>
          <PlatformsSection />
        </Suspense>
      </section>
    </div>
  );
}
