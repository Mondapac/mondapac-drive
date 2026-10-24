import type { ExpoConfig } from 'expo/config';
import en from './src/i18n/en.json';

// Store builds (EAS: bundle identifiers, icons, signing) are a later package. The permission
// texts come from the translation file, like every other piece of copy.
const config: ExpoConfig = {
  name: en.app.name,
  slug: 'mondapac-drive-courier',
  scheme: 'mondapac-courier',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ['location'],
    },
  },
  android: {
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
};

export default config;
