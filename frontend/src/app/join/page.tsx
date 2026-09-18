import { Suspense } from 'react';
import type { Metadata } from 'next';
import JoinPage from '../../components/public/JoinPage';

export const metadata: Metadata = {
  title: 'Join the UDF',
  description: 'Short link used on posters and party cards — opens the membership registration form.',
};

/** Alias for `/register`, kept for short printed links (`/join?ref=UDF-ABC-XYZ`). */
export default function JoinRoute() {
  return (
    <Suspense fallback={null}>
      <JoinPage />
    </Suspense>
  );
}
