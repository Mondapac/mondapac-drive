import { Redirect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { useSession } from '../../providers';
import { OnboardingScreen } from '../../screens/onboarding/OnboardingScreen';

/** The gate after sign-in: a new courier sets up their account, an approved one goes home. */
export default function OnboardingRoute() {
  const router = useRouter();
  const { ready, session } = useSession();
  const goHome = useCallback(() => router.replace('/home'), [router]);
  if (ready && !session) return <Redirect href="/sign-in" />;
  return <OnboardingScreen onReady={goHome} />;
}
