import { useMutation } from '@tanstack/react-query';
import { Linking } from 'react-native';
import { t } from '../../i18n';
import { useServices } from '../../providers';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';
import { onboardingError } from './errors';

/**
 * A contractor sets up their payout account on the payment provider's page, opened in the system
 * browser (never inside the app, so the app never sees bank details). The link is short-lived, so
 * it is asked for on each tap.
 */
export function PayoutSetup() {
  const { api } = useServices();
  const payouts = useMutation({
    mutationFn: async () => {
      const link = await api.payoutOnboardingLink();
      await Linking.openURL(link.url);
    },
  });
  return (
    <>
      <Notice text={t('onboarding.waiting.payoutsHint')} />
      <Button
        label={t('onboarding.waiting.payouts')}
        variant="secondary"
        busy={payouts.isPending}
        onPress={() => payouts.mutate()}
      />
      {payouts.error && <Notice tone="danger" text={onboardingError(payouts.error)} />}
    </>
  );
}
