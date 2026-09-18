'use client';

import RegisterPanel from '../RegisterPanel';
import { useShell } from '../AppShell';
import { BackRow } from './MoreTab';

/**
 * In-app registration screen (More → Member registration form).
 * The form itself lives in `<RegisterPanel>` so the public `/register`
 * website page can reuse it verbatim.
 */
export default function RegisterForm() {
  const { open } = useShell();

  return (
    <>
      <BackRow label="More" onClick={() => open('more', '')} />

      <div className="card hero-card compact" style={{ marginTop: 10 }}>
        <span className="eyebrow">Join the movement</span>
        <h2>Member registration</h2>
        <p>
          One form, one membership number, one QR party card. Details are sealed with
          field-level encryption before they are stored.
        </p>
      </div>

      <RegisterPanel defaultRegion="CENTRAL" />

      <div style={{ height: 12 }} />
    </>
  );
}
