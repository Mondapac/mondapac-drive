import { Redirect } from 'expo-router';
import { Text } from 'react-native';
import { t } from '../i18n';
import { useSession } from '../providers';
import { Screen } from '../ui/Screen';

export default function Index() {
  const { ready, session } = useSession();
  if (!ready) {
    return (
      <Screen title={t('app.name')}>
        <Text>{t('common.loading')}</Text>
      </Screen>
    );
  }
  return <Redirect href={session ? '/home' : '/sign-in'} />;
}
