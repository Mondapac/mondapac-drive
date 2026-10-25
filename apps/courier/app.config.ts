import type { ExpoConfig } from 'expo/config';
import pkg from './package.json';
import { resolveRelease } from './release/release-config.ts';
import en from './src/i18n/en.json';

// The build's variant, version, API and Market come from its environment (eas.json profiles,
// EAS environment variables, or the CI job): see RELEASE.md. The permission texts come from the
// translation file, like every other piece of copy.
// The app's TypeScript has no Node types (React Native code must not lean on them); this file
// alone runs in Node, so it declares the two it uses.
declare const __dirname: string;
declare function require(id: 'node:fs'): { existsSync: (path: string) => boolean };

const { existsSync } = require('node:fs');
const release = resolveRelease(process.env, pkg.version, (code) =>
  existsSync(`${__dirname}/../../config/markets/${code}.json`),
);
const easProjectId = process.env.EAS_PROJECT_ID?.trim();

const config: ExpoConfig = {
  name: `${en.app.name}${release.nameSuffix}`,
  slug: 'mondapac-drive-courier',
  scheme: 'mondapac-courier',
  version: release.version,
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './store/assets/icon.png',
  ios: {
    bundleIdentifier: release.applicationId,
    buildNumber: String(release.buildNumber),
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ['location'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: release.applicationId,
    versionCode: release.buildNumber,
    adaptiveIcon: {
      foregroundImage: './store/assets/adaptive-icon.png',
      backgroundColor: '#0B6E4F',
    },
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'CAMERA',
    ],
    blockedPermissions: ['RECORD_AUDIO'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-splash-screen',
      { image: './store/assets/splash.png', imageWidth: 200, backgroundColor: '#0B6E4F' },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: en.permissions.location.iosAlways,
        locationWhenInUsePermission: en.permissions.location.iosWhenInUse,
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: en.permissions.camera.ios,
        recordAudioAndroid: false,
      },
    ],
  ],
  experiments: { typedRoutes: true },
  ...(easProjectId ? { extra: { eas: { projectId: easProjectId } } } : {}),
  ...(process.env.EAS_OWNER?.trim() ? { owner: process.env.EAS_OWNER.trim() } : {}),
};

export default config;
