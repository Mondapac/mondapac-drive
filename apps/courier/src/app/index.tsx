import { Redirect } from 'expo-router';
import { useEffect } from 'react';
import { Text } from 'react-native';
import { t } from '../i18n';
import { useSession } from '../providers';
import { purgeDocumentCache } from '../screens/onboarding/document-file';
import { Screen } from '../ui/Screen';

export default function Index() {
  const { ready, session } = useSession();
  // A document file left behind by a crash or a kill goes at start, as the proof photos do.
  useEffect(purgeDocumentCache, []);
  if (!ready) {
    return (
      <Screen title={t('app.name')}>
        <Text>{t('common.loading')}</Text>
      </Screen>
    );
  }
  return <Redirect href={session ? '/onboarding' : '/sign-in'} />;
}
