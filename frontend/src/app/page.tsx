'use client';

import { useAuth } from '../lib/auth';
import AppShell from '../components/AppShell';
import PublicHome from '../components/public/PublicHome';
import TermsGate from '../components/TermsGate';
import ChangePasswordGate from '../components/ChangePasswordGate';

/**
 * Home route: signed-in members get the app dashboard; everyone else gets the
 * public, non-member home (mission, become-a-member and open petitions).
 * Auth state is resolved client-side from the token store.
 *
 * Two gates hold a signed-in user before the shell, in priority order:
 *  1. a forced password change — the account was provisioned with a shared
 *     bootstrap password that must be rotated (most urgent, so first);
 *  2. acceptance of the current Terms version (fresh login or a terms bump).
 */
export default function Home() {
  const { ready, authenticated, tcAccepted, mustChangePassword } = useAuth();

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: '#64748b' }}>
        Loading…
      </div>
    );
  }

  if (authenticated && mustChangePassword) {
    return <ChangePasswordGate />;
  }

  if (authenticated && !tcAccepted) {
    return <TermsGate />;
  }

  return authenticated ? <AppShell /> : <PublicHome />;
}
