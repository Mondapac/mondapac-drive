import { useState } from 'react';
import { Platform } from 'react-native';
import { openAppSettings, requestLocationAccess, type LocationAccess } from '../location/tracking';
import { t } from '../i18n';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';

interface Props {
  readonly onGranted: () => void;
  readonly onCancel: () => void;
  readonly request?: () => Promise<LocationAccess>;
}

/**
 * Says why and when the app uses location before the system prompts appear (App Store and
 * Google Play rules for background location), then asks.
 */
export function LocationPermissionScreen({
  onGranted,
  onCancel,
  request = requestLocationAccess,
}: Props) {
  const [state, setState] = useState<LocationAccess | 'idle'>('idle');
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    try {
      const result = await request();
      setState(result);
      if (result === 'granted') onGranted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('permissions.location.title')}>
      <Notice text={t('permissions.location.body')} />
      <Notice
        text={t(
          Platform.OS === 'ios' ? 'permissions.location.ios' : 'permissions.location.android',
        )}
      />
      {state === 'blocked' ? (
        <>
          <Notice tone="warning" text={t('permissions.location.denied')} />
          <Button
            label={t('permissions.location.openSettings')}
            onPress={() => void openAppSettings()}
          />
        </>
      ) : (
        <Button label={t('permissions.location.continue')} busy={busy} onPress={() => void ask()} />
      )}
      <Button label={t('common.cancel')} variant="secondary" onPress={onCancel} />
    </Screen>
  );
}
