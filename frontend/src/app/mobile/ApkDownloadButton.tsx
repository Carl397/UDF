'use client';

import type { ReactNode } from 'react';

type Props = {
  /** Counted download endpoint (logs device/OS/referrer, then 302s to the APK). */
  href: string;
  className?: string;
  children: ReactNode;
};

/**
 * Renders the app download as a <button>, not an <a>. This keeps the APK source
 * URL out of the DOM and away from the browser's hover/status-bar preview, while
 * still hitting the counted /download/apk endpoint on click (which redirects to
 * the file and starts the download).
 */
export default function ApkDownloadButton({ href, className, children }: Props) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        window.location.assign(href);
      }}
    >
      {children}
    </button>
  );
}
