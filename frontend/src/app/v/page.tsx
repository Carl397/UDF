import { Suspense } from 'react';
import type { Metadata } from 'next';
import VerifyPage from '../../components/public/VerifyPage';

export const metadata: Metadata = {
  title: 'UDF party card · verify',
  description:
    'Scan a UDF party card QR code to verify a membership number, ward and party office, and to join the movement.',
  openGraph: {
    title: 'Verify a UDF party card',
    description: 'Membership number, ward, offices held and party contact details.',
    type: 'profile',
  },
};

export default function VerifyRoute() {
  return (
    <Suspense fallback={null}>
      <VerifyPage />
    </Suspense>
  );
}
