import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { AuthProvider } from '../lib/auth';
import SplashScreen from '../components/SplashScreen';
import AnalyticsBeacon from '../components/AnalyticsBeacon';

export const metadata: Metadata = {
  title: 'UDF Party',
  description:
    'Official UDF party platform — secure member management with map and heat-map analytics.',
  applicationName: 'UDF Party',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', type: 'image/x-icon' },
      { url: '/brand/udf-illustration.png', sizes: 'any', type: 'image/png' },
    ],
    apple: [{ url: '/brand/udf-illustration.png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#C8102E',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SplashScreen />
        <AnalyticsBeacon />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
