import { Redirect, useRouter } from 'expo-router';
import { useSession } from '../providers';
import { EarningsScreen } from '../screens/EarningsScreen';

export default function EarningsRoute() {
  const router = useRouter();
  const { session } = useSession();
  if (!session) return <Redirect href="/sign-in" />;
  return <EarningsScreen onBack={() => router.back()} />;
}
