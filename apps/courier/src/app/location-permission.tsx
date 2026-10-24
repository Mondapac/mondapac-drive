import { useRouter } from 'expo-router';
import { LocationPermissionScreen } from '../screens/LocationPermissionScreen';

export default function LocationPermissionRoute() {
  const router = useRouter();
  return (
    <LocationPermissionScreen onGranted={() => router.back()} onCancel={() => router.back()} />
  );
}
