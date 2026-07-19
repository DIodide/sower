import { redirect } from 'next/navigation';

/** Ingestion moved into /system — old links keep working. */
export default function IngestionRedirect() {
  redirect('/system#ingest-health');
}
