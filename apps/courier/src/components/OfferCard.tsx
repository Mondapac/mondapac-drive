import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CourierSettings, Offer, OfferStop } from '../api/schemas';
import { secondsLeft } from '../domain/countdown';
import { formatDistance, formatMoney } from '../domain/format';
import { t } from '../i18n';
import type { Clock } from '../platform/clock/clock';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { colors, space } from '../ui/theme';

interface Props {
  readonly offer: Offer;
  readonly settings: CourierSettings;
  readonly clock: Clock;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
  /** Called once when the countdown reaches zero. */
  readonly onExpired: () => void;
}

/** The suburb and postcode of a stop, or the postcode alone when delivery has no suburb. */
function area(stop: OfferStop): string {
  return stop.suburb
    ? t('offer.area', { suburb: stop.suburb, postcode: stop.postcode })
    : stop.postcode;
}

export function OfferCard({ offer, settings, clock, busy, onAccept, onDecline, onExpired }: Props) {
  const [left, setLeft] = useState(() => secondsLeft(offer.expiresAt, clock.now()));

  useEffect(() => {
    setLeft(secondsLeft(offer.expiresAt, clock.now()));
    const timer = setInterval(() => setLeft(secondsLeft(offer.expiresAt, clock.now())), 1000);
    return () => clearInterval(timer);
  }, [offer.expiresAt, clock]);

  const expired = left === 0;
  const latestOnExpired = useRef(onExpired);
  latestOnExpired.current = onExpired;
  useEffect(() => {
    // Once per offer, when it runs out.
    if (expired) latestOnExpired.current();
  }, [expired, offer.id]);

  return (
    <View style={styles.card} accessibilityLabel={t('offer.title')}>
      <Text style={styles.title}>{t('offer.title')}</Text>
      {/* An estimate (no waiting time); null is "unavailable", never a zero. */}
      <Text style={offer.earnings ? styles.pay : styles.hint}>
        {offer.earnings
          ? t('offer.pay', { amount: formatMoney(offer.earnings, settings.locale) })
          : t('offer.payUnavailable')}
      </Text>
      <Text style={styles.line}>
        {t('offer.distance', {
          distance: formatDistance(offer.distanceMetres, settings.distanceUnit, settings.locale),
        })}
      </Text>
      {offer.temperature !== 'ambient' && (
        <Text style={styles.cold}>
          {t('offer.coldChain', { temperature: t(`temperature.${offer.temperature}`) })}
        </Text>
      )}
      <Text style={styles.label}>{t('offer.pickup')}</Text>
      <Text style={styles.line}>{area(offer.pickup)}</Text>
      <Text style={styles.label}>{t('offer.dropoff')}</Text>
      <Text style={styles.line}>{area(offer.dropoff)}</Text>
      <Text style={styles.hint}>{t('offer.addressAfterAccept')}</Text>
      {expired ? (
        <Notice tone="warning" text={t('offer.expired')} />
      ) : (
        <>
          <Text accessibilityLiveRegion="polite" style={styles.countdown}>
            {t('offer.expiresIn', { seconds: left })}
          </Text>
          <Button label={t('offer.accept')} onPress={onAccept} busy={busy} />
          <Button
            label={t('offer.decline')}
            variant="secondary"
            onPress={onDecline}
            disabled={busy}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.xs,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  pay: { fontSize: 18, fontWeight: '600', color: colors.primary },
  label: { marginTop: space.sm, color: colors.muted, fontSize: 13, textTransform: 'uppercase' },
  line: { color: colors.text, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 13 },
  cold: { color: colors.warning, fontWeight: '600' },
  countdown: { marginTop: space.sm, fontSize: 16, fontWeight: '600', color: colors.text },
});
