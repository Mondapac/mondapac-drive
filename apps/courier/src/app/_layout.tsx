import '../location/register-task';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { I18nManager } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { courierApi } from '../api';
import { currentLocale } from '../i18n';
import { systemClock } from '../platform/clock/clock';
import { purgeProofPhotoCache } from '../pod/photo';
import { AppProviders, createQueryClient } from '../providers';

// A right-to-left language mirrors the layout. React Native applies a change on the next start,
// which is when a new device language takes effect anyway.
const rightToLeft = currentLocale().direction === 'rtl';
if (I18nManager.isRTL !== rightToLeft) {
  I18nManager.allowRTL(rightToLeft);
  I18nManager.forceRTL(rightToLeft);
}

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  useEffect(purgeProofPhotoCache, []);
  return (
    <SafeAreaProvider>
      <AppProviders api={courierApi()} clock={systemClock} queryClient={queryClient}>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }} />
      </AppProviders>
    </SafeAreaProvider>
  );
}
