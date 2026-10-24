import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../domain/format';
import { t } from '../i18n';
import { queryKeys, useServices, useSettings } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { colors, space } from '../ui/theme';

/** A stub until payouts (package 10) serves real figures. */
export function EarningsScreen({ onBack }: { readonly onBack: () => void }) {
  const { api } = useServices();
  const settings = useSettings();
  const earnings = useQuery({ queryKey: queryKeys.earnings, queryFn: () => api.earnings() });

  return (
    <Screen title={t('earnings.title')}>
      <Notice text={t('earnings.stubNotice')} />
      {earnings.isError && <Notice tone="danger" text={errorMessage(earnings.error)} />}
      {earnings.data && settings ? (
        <>
          <View style={styles.row}>
            <Text style={styles.label}>{t('earnings.today')}</Text>
            <Text style={styles.amount}>{formatMoney(earnings.data.today, settings.locale)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>{t('earnings.week')}</Text>
            <Text style={styles.amount}>{formatMoney(earnings.data.week, settings.locale)}</Text>
          </View>
          <Text style={styles.label}>
            {t('earnings.deliveries', { count: earnings.data.deliveriesToday })}
          </Text>
        </>
      ) : (
        !earnings.isError && <Text>{t('common.loading')}</Text>
      )}
      <Button label={t('common.back')} variant="secondary" onPress={onBack} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  label: { fontSize: 16, color: colors.muted },
  amount: { fontSize: 18, fontWeight: '700', color: colors.text },
});
