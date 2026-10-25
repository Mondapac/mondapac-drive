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
import { colors, space } from '../ui/theme';

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

  return (
    <Screen title={t('earnings.title')}>
      {error && <Notice tone="danger" text={errorMessage(error)} />}
      {earnings.data && locale ? (
        <>
          <View style={styles.row}>
            <Text style={styles.label}>{t('earnings.today')}</Text>
            <Text style={styles.amount}>{formatMoney(earnings.data.today, locale)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>{t('earnings.week')}</Text>
            <Text style={styles.amount}>{formatMoney(earnings.data.week, locale)}</Text>
          </View>
          <Text style={styles.label}>
            {t('earnings.deliveries', { count: earnings.data.deliveriesToday })}
          </Text>
        </>
      ) : (
        !earnings.isError && <Text>{t('common.loading')}</Text>
      )}

      {balance.data && locale && (
        <>
          <View style={styles.row}>
            <Text style={styles.label}>{t('earnings.balance')}</Text>
            <Text style={styles.amount}>{formatMoney(balance.data.balance.total, locale)}</Text>
          </View>
          {!isZero(balance.data.balance.tax) && (
            <Text style={styles.note}>
              {t('earnings.balanceTax', { tax: formatMoney(balance.data.balance.tax, locale) })}
            </Text>
          )}
          <Text accessibilityRole="header" style={styles.heading}>
            {t('earnings.recent')}
          </Text>
          {balance.data.entries.length === 0 ? (
            <Notice text={t('earnings.none')} />
          ) : (
            balance.data.entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} locale={locale} />
            ))
          )}
        </>
      )}

      <Button
        label={t('earnings.refresh')}
        variant="secondary"
        busy={earnings.isFetching || balance.isFetching}
        onPress={() => {
          void earnings.refetch();
          void balance.refetch();
        }}
      />
      <Button label={t('common.back')} variant="secondary" onPress={onBack} />
    </Screen>
  );
}

function EntryRow({ entry, locale }: { readonly entry: LedgerEntry; readonly locale: string }) {
  const label = kindLabel(entry.kind);
  const amount = formatMoney(withTax(entry.amount, entry.tax), locale);
  const when = formatDateTime(entry.occurredAt, locale);
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}, ${when}, ${amount}`}>
      <View>
        <Text style={styles.entry}>{label}</Text>
        <Text style={styles.note}>{when}</Text>
      </View>
      <Text style={styles.entry}>{amount}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  label: { fontSize: 16, color: colors.muted },
  amount: { fontSize: 18, fontWeight: '700', color: colors.text },
  heading: { marginTop: space.md, fontSize: 18, fontWeight: '600', color: colors.text },
  entry: { fontSize: 16, color: colors.text },
  note: { fontSize: 13, color: colors.muted },
});
