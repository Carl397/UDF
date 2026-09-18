'use client';

import type { ReactNode } from 'react';
import { ToastProvider } from './ui';
import Logo from './Logo';

/**
 * Chrome for the public-facing website pages (join / confirm / QR verify).
 *
 * These pages are opened from a printed QR code, an SMS link or a poster —
 * usually by someone who is not signed in, so they carry no app shell, no tab
 * bar and no auth guard.
 */
export default function PublicFrame({
  title,
  subtitle,
  children,
  foot,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <ToastProvider>
      <div className="pub">
        <header className="pub-head">
          <span className="pub-flag">
            <Logo size={102} wordmark={false} />
            <span>Party</span>
          </span>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </header>
        <div className="pub-stripe" />
        <main className="pub-body">
          {children}
          {foot}
        </main>
      </div>
    </ToastProvider>
  );
}

export function PublicFoot({ extra }: { extra?: ReactNode }) {
  return (
    <footer className="pub-foot">
      <a href="/register">Become a member</a> · <a href="/login">Member sign in</a>
      {extra}
    </footer>
  );
}
