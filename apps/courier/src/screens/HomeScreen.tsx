import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import type { ShiftState } from '../api/schemas';
import { OfferCard } from '../components/OfferCard';
import { formatMoney } from '../domain/format';
import { devicePush } from '../push/device-push';
import type { PushService } from '../push/push-service';
import { useOfferPush } from '../push/use-offer-push';
import { t, type TranslationKey } from '../i18n';
import { queryKeys, useServices, useSession, useSettings } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { makeStyles, radius, space, text } from '../ui/theme';

/** How often the app asks for a new offer while online and offer pushes are off. */
export const OFFER_POLL_MS = 5_000;
/** The fallback poll once this device gets offer pushes. */
export const OFFER_POLL_PUSH_MS = 30_000;

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
  /** Brings the home screen forward when an offer push arrives or is tapped. */
  readonly onOfferPush?: () => void;
  /** The device's push notifications; tests pass a fake. */
  readonly push?: PushService;
}

export function HomeScreen({
  onOpenJob,
  onOpenEarnings,
  onNeedLocation,
  onOfferPush,
  push = devicePush,
}: Props) {
  const { api, clock, tracking } = useServices();
  const { session, signOut } = useSession();
  const settings = useSettings();
  const queryClient = useQueryClient();

  const styles = useStyles();

  const status = useQuery({ queryKey: queryKeys.status, queryFn: () => api.status() });
  // Today's takings in the status panel; the panel simply leaves them out if the call fails.
  const earnings = useQuery({ queryKey: queryKeys.earnings, queryFn: () => api.earnings() });
  const online = status.data?.shift === 'online';
  const activeDeliveryId = status.data?.activeDeliveryId ?? null;

  const { registered } = useOfferPush(push, api, session !== null, () => {
    onOfferPush?.();
    void queryClient.invalidateQueries({ queryKey: queryKeys.offer });
  });

  const offer = useQuery({
    queryKey: queryKeys.offer,
    queryFn: () => api.currentOffer(),
    enabled: online && !activeDeliveryId,
    // Pushes bring offers in at once; polling stays as the fallback.
    refetchInterval: registered ? OFFER_POLL_PUSH_MS : OFFER_POLL_MS,
  });

  const shift = useMutation({
    mutationFn: async (next: 'online' | 'offline') => {
      if (next === 'online') {
        if ((await tracking.access()) !== 'granted') return null;
        const updated = await api.setShift('online');
        await tracking.start();
        return updated;
      }
      // Sharing stops on the device first, whatever the server answers.
      await tracking.stop();
      return api.setShift('offline');
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
  const today = earnings.data && settings ? earnings.data : null;

  const shiftButton = activeDeliveryId ? null : online ? (
    <Button
      label={t('home.goOffline')}
      variant="secondary"
      busy={shift.isPending}
      onPress={() => shift.mutate('offline')}
    />
  ) : (
    <Button
      label={t('home.goOnline')}
      busy={shift.isPending}
      disabled={!status.data}
      onPress={() => shift.mutate('online')}
    />
  );

  return (
    <Screen
      title={t('home.title')}
      footer={
        <>
          {shiftButton}
          <View style={styles.row}>
            <Button
              label={t('home.earnings')}
              variant="secondary"
              size="small"
              grow
              onPress={onOpenEarnings}
            />
            <Button
              label={t('home.signOut')}
              variant="secondary"
              size="small"
              grow
              onPress={() =>
                // Offer pushes stop while the session is still valid, then the session ends.
                void api
                  .removePushDevice()
                  .catch(() => undefined)
                  .then(signOut)
              }
            />
          </View>
        </>
      }
    >
      <View style={styles.hero}>
        <View style={styles.heroHead}>
          <View
            style={[styles.light, shiftState === 'offline' ? styles.lightOff : styles.lightOn]}
          />
          <Text accessibilityLiveRegion="polite" style={styles.shift}>
            {t(SHIFT_LABEL[shiftState])}
          </Text>
        </View>
        {shiftState === 'offline' ? (
          <Text style={styles.heroHint}>{t('home.offlineHint')}</Text>
        ) : online && !activeDeliveryId && !offer.data ? (
          <Text style={styles.heroHint}>{t('home.waiting')}</Text>
        ) : null}
        {today && settings && (
          <Text style={styles.today}>
            {t('home.todaySummary', {
              amount: formatMoney(today.today, settings.locale),
              count: today.deliveriesToday,
            })}
          </Text>
        )}
      </View>

      {error && <Notice tone="danger" text={errorMessage(error)} />}

      {activeDeliveryId ? (
        <Button label={t('home.activeJob')} onPress={() => onOpenJob(activeDeliveryId)} />
      ) : (
        online &&
        offer.data &&
        settings && (
          <OfferCard
            offer={offer.data}
            settings={settings}
            clock={clock}
            busy={respond.isPending}
            onAccept={() => respond.mutate({ id: offer.data!.id, accept: true })}
            onDecline={() => respond.mutate({ id: offer.data!.id, accept: false })}
            onExpired={() => void queryClient.invalidateQueries({ queryKey: queryKeys.offer })}
          />
        )
      )}
    </Screen>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    hero: { backgroundColor: c.hero, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
    heroHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    light: { width: 12, height: 12, borderRadius: 6 },
    lightOn: { backgroundColor: c.scheme === 'dark' ? c.primary : '#7BE3B5' },
    lightOff: { backgroundColor: c.heroMuted },
    shift: { fontSize: text.heading, fontWeight: '800', color: c.heroText, letterSpacing: -0.4 },
    heroHint: { fontSize: text.body, color: c.heroMuted },
    today: {
      marginTop: space.sm,
      fontSize: text.label,
      fontWeight: '700',
      color: c.heroText,
      fontVariant: ['tabular-nums'],
    },
    row: { flexDirection: 'row', gap: space.sm },
  }),
);
