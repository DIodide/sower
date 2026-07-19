// /system — the merged ops surface: ingest health, the local capture agent &
// Workday sessions, and the platform overview. The old /ingestion, /sessions,
// and /platforms routes redirect here; per-platform and tenant drill-downs
// stay at their own URLs, linked from the Platforms section.
import { SectionHeading } from '../../lib/ui';
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
        <IngestSection />
      </section>

      <section id="sessions">
        <SectionHeading>Local agent &amp; Workday sessions</SectionHeading>
        <SessionsSection />
      </section>

      <section id="platforms">
        <SectionHeading>Platforms</SectionHeading>
        <PlatformsSection />
      </section>
    </div>
  );
}
