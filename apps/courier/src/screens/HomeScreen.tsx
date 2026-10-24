import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text } from 'react-native';
import type { ShiftState } from '../api/schemas';
import { OfferCard } from '../components/OfferCard';
import { t, type TranslationKey } from '../i18n';
import { queryKeys, useServices, useSession, useSettings } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { colors } from '../ui/theme';

/** How often the app asks for a new offer while online (dispatch pushes later; see README). */
export const OFFER_POLL_MS = 5_000;

const SHIFT_LABEL: Readonly<Record<ShiftState, TranslationKey>> = {
  offline: 'home.offline',
  online: 'home.online',
  on_delivery: 'home.onDelivery',
  paused: 'home.paused',
};

interface Props {
  readonly onOpenJob: (deliveryId: string) => void;
  readonly onOpenEarnings: () => void;
  readonly onNeedLocation: () => void;
}

export function HomeScreen({ onOpenJob, onOpenEarnings, onNeedLocation }: Props) {
  const { api, clock, tracking } = useServices();
  const { signOut } = useSession();
  const settings = useSettings();
  const queryClient = useQueryClient();

  const status = useQuery({ queryKey: queryKeys.status, queryFn: () => api.status() });
  const online = status.data?.shift === 'online';
  const activeDeliveryId = status.data?.activeDeliveryId ?? null;

  const offer = useQuery({
    queryKey: queryKeys.offer,
    queryFn: () => api.currentOffer(),
    enabled: online && !activeDeliveryId,
    refetchInterval: OFFER_POLL_MS,
  });

  const shift = useMutation({
    mutationFn: async (next: 'online' | 'offline') => {
      if (next === 'online') {
        if ((await tracking.access()) !== 'granted') return null;
        const updated = await api.setShift('online');
        await tracking.start();
        return updated;
      }
      const updated = await api.setShift('offline');
      await tracking.stop();
      return updated;
    },
    onSuccess: (updated, next) => {
      if (!updated) {
        if (next === 'online') onNeedLocation();
        return;
      }
      queryClient.setQueryData(queryKeys.status, updated);
      if (next === 'offline') queryClient.setQueryData(queryKeys.offer, null);
    },
  });

  const respond = useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      if (!accept) {
        await api.declineOffer(id);
        return null;
      }
      return (await api.acceptOffer(id)).deliveryId;
    },
    onSettled: () => {
      queryClient.setQueryData(queryKeys.offer, null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
    onSuccess: (deliveryId) => {
      if (deliveryId) onOpenJob(deliveryId);
    },
  });

  const shiftState = status.data?.shift ?? 'offline';
  const error = shift.error ?? respond.error ?? status.error;

  return (
    <Screen title={t('home.title')}>
      <Text accessibilityLiveRegion="polite" style={styles.shift}>
        {t(SHIFT_LABEL[shiftState])}
      </Text>
      {error && <Notice tone="danger" text={errorMessage(error)} />}

      {activeDeliveryId ? (
        <Button label={t('home.activeJob')} onPress={() => onOpenJob(activeDeliveryId)} />
      ) : online ? (
        <>
          {offer.data && settings ? (
            <OfferCard
              offer={offer.data}
              settings={settings}
              clock={clock}
              busy={respond.isPending}
              onAccept={() => respond.mutate({ id: offer.data!.id, accept: true })}
              onDecline={() => respond.mutate({ id: offer.data!.id, accept: false })}
              onExpired={() => void queryClient.invalidateQueries({ queryKey: queryKeys.offer })}
            />
          ) : (
            <Notice text={t('home.waiting')} />
          )}
          <Button
            label={t('home.goOffline')}
            variant="secondary"
            busy={shift.isPending}
            onPress={() => shift.mutate('offline')}
          />
        </>
      ) : (
        <Button
          label={t('home.goOnline')}
          busy={shift.isPending}
          disabled={!status.data}
          onPress={() => shift.mutate('online')}
        />
      )}

      <Button label={t('home.earnings')} variant="secondary" onPress={onOpenEarnings} />
      <Button label={t('home.signOut')} variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  shift: { fontSize: 18, fontWeight: '600', color: colors.primary },
});
