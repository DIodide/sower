import { redirect } from 'next/navigation';

/**
 * The platform overview moved into /system — old links keep working.
 * Per-platform drill-downs stay at /platforms/[platform].
 */
export default function PlatformsRedirect() {
  redirect('/system#platforms');
}
