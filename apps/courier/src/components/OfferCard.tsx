import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CourierSettings, Offer, OfferStop } from '../api/schemas';
import { secondsLeft } from '../domain/countdown';
import { formatDistance, formatMoney } from '../domain/format';
import { t } from '../i18n';
import type { Clock } from '../platform/clock/clock';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { Notice } from '../ui/Notice';
import { SlideToConfirm } from '../ui/SlideToConfirm';
import { makeStyles, radius, space, text } from '../ui/theme';

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
  const styles = useStyles();
  const [left, setLeft] = useState(() => secondsLeft(offer.expiresAt, clock.now()));
  // The countdown bar is measured against the time the offer had when it first showed.
  const [total] = useState(() => Math.max(left, 1));

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
    <Card raised label={t('offer.title')}>
      <View style={styles.head}>
        <Text style={styles.title}>{t('offer.title')}</Text>
        {!expired && (
          <Text accessibilityLiveRegion="polite" style={styles.countdown}>
            {t('offer.expiresIn', { seconds: left })}
          </Text>
        )}
      </View>
      {!expired && (
        <View style={styles.timer}>
          <View style={[styles.timerFill, { width: `${Math.min(left / total, 1) * 100}%` }]} />
        </View>
      )}

      {/* An estimate (no waiting time); null is "unavailable", never a zero. */}
      {offer.earnings ? (
        <View>
          <Text style={styles.payLabel}>{t('offer.payLabel')}</Text>
          <Text style={styles.pay}>{formatMoney(offer.earnings, settings.locale)}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>{t('offer.payUnavailable')}</Text>
      )}

      <View style={styles.chips}>
        <Chip
          label={t('offer.distance', {
            distance: formatDistance(offer.distanceMetres, settings.distanceUnit, settings.locale),
          })}
        />
        {offer.temperature !== 'ambient' && (
          <Chip
            tone="cold"
            label={t('offer.coldChain', { temperature: t(`temperature.${offer.temperature}`) })}
          />
        )}
      </View>

      <View style={styles.route}>
        <StopLine kind="pickup" heading={t('offer.pickup')} place={area(offer.pickup)} />
        <View style={styles.connector} />
        <StopLine kind="dropoff" heading={t('offer.dropoff')} place={area(offer.dropoff)} />
      </View>
      <Text style={styles.hint}>{t('offer.addressAfterAccept')}</Text>

      {expired ? (
        <Notice tone="warning" text={t('offer.expired')} />
      ) : (
        <View style={styles.actions}>
          <SlideToConfirm label={t('offer.accept')} onConfirm={onAccept} busy={busy} />
          <Button
            label={t('offer.decline')}
            variant="secondary"
            size="small"
            onPress={onDecline}
            disabled={busy}
          />
        </View>
      )}
    </Card>
  );
}

function StopLine({
  kind,
  heading,
  place,
}: {
  readonly kind: 'pickup' | 'dropoff';
  readonly heading: string;
  readonly place: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.stop}>
      <View style={[styles.pin, kind === 'pickup' ? styles.pickupPin : styles.dropoffPin]} />
      <View style={styles.stopText}>
        <Text style={styles.stopHeading}>{heading}</Text>
        <Text style={styles.place}>{place}</Text>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    head: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: space.sm,
    },
    title: { flexShrink: 1, fontSize: text.label, fontWeight: '800', color: c.text },
    countdown: {
      fontSize: text.small,
      fontWeight: '800',
      color: c.primary,
      fontVariant: ['tabular-nums'],
    },
    timer: { height: 4, borderRadius: radius.pill, backgroundColor: c.raised, overflow: 'hidden' },
    timerFill: { height: 4, backgroundColor: c.primary },
    payLabel: { color: c.muted, fontSize: text.small, fontWeight: '600' },
    pay: {
      color: c.text,
      fontSize: text.display,
      fontWeight: '800',
      letterSpacing: -1,
      fontVariant: ['tabular-nums'],
    },
    hint: { color: c.muted, fontSize: text.small },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    route: { gap: 2 },
    stop: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
    pin: { width: 14, height: 14, marginTop: 3, borderWidth: 3 },
    pickupPin: { borderRadius: 3, borderColor: c.text },
    dropoffPin: { borderRadius: 7, borderColor: c.primary },
    connector: { width: 2, height: 14, marginStart: 6, backgroundColor: c.border },
    stopText: { flex: 1 },
    stopHeading: { color: c.muted, fontSize: text.caption, fontWeight: '700' },
    place: { color: c.text, fontSize: text.label, fontWeight: '700' },
    actions: { gap: space.sm, marginTop: space.xs },
  }),
);
