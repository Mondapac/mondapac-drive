import { Redirect, useRouter } from 'expo-router';
import { useSession } from '../providers';
import { HomeScreen } from '../screens/HomeScreen';

export default function HomeRoute() {
  const router = useRouter();
  const { ready, session } = useSession();
  if (ready && !session) return <Redirect href="/sign-in" />;
  return (
    <HomeScreen
      onOpenJob={(id) => router.push({ pathname: '/job/[id]', params: { id } })}
      onOpenEarnings={() => router.push('/earnings')}
      onNeedLocation={() => router.push('/location-permission')}
      onOfferPush={() => router.navigate('/home')}
    />
  );
}
