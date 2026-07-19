import type { ReactNode } from 'react';
import { AnswersSubnav } from './subnav';

// Shared frame for the Answers area: the flat sub-nav (Answers | Profile |
// Resumes) above whichever section page is active.
export default function AnswersLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <AnswersSubnav />
      {children}
    </div>
  );
}
