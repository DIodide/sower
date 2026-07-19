import { redirect } from 'next/navigation';

/** Sessions moved into /system — old links keep working. */
export default function SessionsRedirect() {
  redirect('/system#sessions');
}
