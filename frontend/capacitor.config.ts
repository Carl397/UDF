import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor shell config — wraps the statically-exported Next.js app
 * (webDir: out) in a native Android WebView to produce the UDF APK.
 */
const config: CapacitorConfig = {
  appId: 'com.udf.party',
  appName: 'UDF Party',
  webDir: 'out',
  // Serve the bundled app. Use 'http' for dev/debug so the WebView can reach
  // the local backend (https scheme blocks mixed-content http API calls).
  server: { androidScheme: 'http' },
  backgroundColor: '#C8102E',
  plugins: {
    SplashScreen: {
      // Display the launch poster for five seconds.
      launchShowDuration: 5000,
      // Black matches the letterboxing baked into the splash art, so the bars
      // around the fitted poster are invisible on any aspect ratio.
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
      // FIT_CENTER, not CENTER_CROP: the poster must be shown whole. CENTER_CROP
      // zooms until the frame is filled, which cuts off its top and bottom.
      androidScaleType: 'FIT_CENTER',
      splashFullScreen: true,
      splashImmersive: true,
      showSpinner: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#C8102E',
    },
  },
};

export default config;
