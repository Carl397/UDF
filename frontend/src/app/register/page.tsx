import { Suspense } from 'react';
import type { Metadata } from 'next';
import JoinPage from '../../components/public/JoinPage';

export const metadata: Metadata = {
  title: 'Join the UDF · Member registration',
  description:
    'Register as a UDF member. One form, one membership number and a QR party card you can verify anywhere.',
  openGraph: {
    title: 'Join the UDF',
    description: 'One flag · One movement. Register your membership in under two minutes.',
    type: 'website',
  },
};

export default function RegisterRoute() {
  return (
    <Suspense fallback={null}>
      <JoinPage />
    </Suspense>
  );
}
