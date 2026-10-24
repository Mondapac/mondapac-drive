import '../location/register-task';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { courierApi } from '../api';
import { systemClock } from '../platform/clock/clock';
import { purgeProofPhotoCache } from '../pod/photo';
import { AppProviders, createQueryClient } from '../providers';

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
