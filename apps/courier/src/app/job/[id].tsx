import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSession } from '../../providers';
import { JobScreen } from '../../screens/JobScreen';

export default function JobRoute() {
  const router = useRouter();
  const { session } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!session) return <Redirect href="/sign-in" />;
  return <JobScreen deliveryId={id} onDone={() => router.replace('/home')} />;
}
