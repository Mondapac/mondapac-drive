import { Redirect } from 'expo-router';
import { useSession } from '../providers';
import { SignInScreen } from '../screens/SignInScreen';

export default function SignInRoute() {
  const { session } = useSession();
  return session ? <Redirect href="/onboarding" /> : <SignInScreen />;
}
