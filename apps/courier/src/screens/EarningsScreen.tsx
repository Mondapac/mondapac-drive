import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { LEDGER_ENTRY_KINDS, type LedgerEntry, type LedgerEntryKind } from '../api/schemas';
import { formatDateTime, formatMoney, isZero, withTax } from '../domain/format';
import { t } from '../i18n';
import { queryKeys, useServices, useSettings } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { Card } from '../ui/Card';
import { makeStyles, radius, space, text } from '../ui/theme';

/** How many ledger entries the screen lists. */
export const RECENT_ENTRIES = 20;

function kindLabel(kind: string): string {
  return LEDGER_ENTRY_KINDS.includes(kind as LedgerEntryKind)
    ? t(`earnings.kinds.${kind as LedgerEntryKind}`)
    : t('earnings.kinds.other');
}

/** Today and this week (payouts summary), what is owed and the latest ledger entries. */
export function EarningsScreen({ onBack }: { readonly onBack: () => void }) {
  const { api } = useServices();
  const settings = useSettings();
  const earnings = useQuery({ queryKey: queryKeys.earnings, queryFn: () => api.earnings() });
  const balance = useQuery({
    queryKey: queryKeys.balance,
    queryFn: () => api.balance(RECENT_ENTRIES),
  });
  const locale = settings?.locale;
  const error = earnings.error ?? balance.error;

  const styles = useStyles();
  return (
    <Screen
      title={t('earnings.title')}
      footer={
        <View style={styles.row}>
          <Button
            label={t('earnings.refresh')}
            variant="secondary"
            size="small"
            grow
            busy={earnings.isFetching || balance.isFetching}
            onPress={() => {
              void earnings.refetch();
              void balance.refetch();
            }}
          />
          <Button label={t('common.back')} variant="secondary" size="small" grow onPress={onBack} />
        </View>
      }
    >
      {error && <Notice tone="danger" text={errorMessage(error)} />}
      {earnings.data && locale ? (
        <>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>{t('earnings.week')}</Text>
            <Text style={styles.heroAmount}>{formatMoney(earnings.data.week, locale)}</Text>
            <Text style={styles.heroLabel}>
              {t('earnings.deliveries', { count: earnings.data.deliveriesToday })}
            </Text>
          </View>
          <View style={styles.row}>
            <Tile label={t('earnings.today')} value={formatMoney(earnings.data.today, locale)} />
            {balance.data && (
              <Tile
                label={t('earnings.balance')}
                value={formatMoney(balance.data.balance.total, locale)}
                note={
                  isZero(balance.data.balance.tax)
                    ? undefined
                    : t('earnings.balanceTax', {
                        tax: formatMoney(balance.data.balance.tax, locale),
                      })
                }
              />
            )}
          </View>
        </>
      ) : (
        !earnings.isError && <Notice text={t('common.loading')} />
      )}

      {balance.data && locale && (
        <>
          <Text accessibilityRole="header" style={styles.heading}>
            {t('earnings.recent')}
          </Text>
          {balance.data.entries.length === 0 ? (
            <Notice text={t('earnings.none')} />
          ) : (
            <Card>
              {balance.data.entries.map((entry, index) => (
                <EntryRow key={entry.id} entry={entry} locale={locale} first={index === 0} />
              ))}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | undefined;
}) {
  const styles = useStyles();
  return (
    <View style={styles.tile}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.amount}>{value}</Text>
      {note && <Text style={styles.note}>{note}</Text>}
    </View>
  );
}

function EntryRow({
  entry,
  locale,
  first,
}: {
  readonly entry: LedgerEntry;
  readonly locale: string;
  readonly first: boolean;
}) {
  const styles = useStyles();
  const label = kindLabel(entry.kind);
  const amount = formatMoney(withTax(entry.amount, entry.tax), locale);
  const when = formatDateTime(entry.occurredAt, locale);
  return (
    <View
      style={[styles.entryRow, !first && styles.divider]}
      accessible
      accessibilityLabel={`${label}, ${when}, ${amount}`}
    >
      <View style={styles.entryText}>
        <Text style={styles.entry}>{label}</Text>
        <Text style={styles.note}>{when}</Text>
      </View>
      <Text style={styles.entryAmount}>{amount}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    hero: { backgroundColor: c.hero, borderRadius: radius.lg, padding: space.lg, gap: space.xs },
    heroLabel: { color: c.heroMuted, fontSize: text.body, fontWeight: '600' },
    heroAmount: {
      color: c.heroText,
      fontSize: text.display,
      fontWeight: '800',
      letterSpacing: -1,
      fontVariant: ['tabular-nums'],
    },
    row: { flexDirection: 'row', gap: space.sm },
    tile: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      padding: space.md,
      gap: 2,
    },
    label: { fontSize: text.small, color: c.muted, fontWeight: '600' },
    amount: {
      fontSize: text.title,
      fontWeight: '800',
      color: c.text,
      fontVariant: ['tabular-nums'],
    },
    heading: { fontSize: text.label, fontWeight: '800', color: c.text },
    entryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: space.sm,
    },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    entryText: { flex: 1 },
    entry: { fontSize: text.label, color: c.text, fontWeight: '600' },
    entryAmount: {
      fontSize: text.label,
      color: c.text,
      fontWeight: '800',
      fontVariant: ['tabular-nums'],
    },
    note: { fontSize: text.small, color: c.muted },
  }),
);
