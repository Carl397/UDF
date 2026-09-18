import type { Metadata } from 'next';
import TermsPage from '../../components/public/TermsPage';

export const metadata: Metadata = {
  title: 'Terms & Conditions · UDF',
  description:
    'The UDF platform terms: membership, acceptable use, contacting your ward councillor, privacy (POPIA), moderation and device security.',
};

export default function TermsRoute() {
  return <TermsPage />;
}
