import { redirect } from 'next/navigation';

/** The Queue merged into the Applications workspace — old links keep working. */
export default function QueueRedirect() {
  redirect('/');
}
