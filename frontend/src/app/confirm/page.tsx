import { Suspense } from 'react';
import type { Metadata } from 'next';
import ConfirmPage from '../../components/public/ConfirmPage';

export const metadata: Metadata = {
  title: 'Confirm your UDF membership or mandate',
  description: 'Opens a single-use party link to activate a membership or accept a mandate.',
  // Confirmation links carry a secret token — never index or archive them.
  robots: { index: false, follow: false },
};

export default function ConfirmRoute() {
  return (
    <Suspense fallback={null}>
      <ConfirmPage />
    </Suspense>
  );
}
