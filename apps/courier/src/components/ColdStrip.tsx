import { StyleSheet, Text, View } from 'react-native';
import type { ColdChainLimits } from '../api/schemas';
import { t } from '../i18n';
import { makeStyles, space, text } from '../ui/theme';

interface Props {
  readonly temperature: 'chilled' | 'frozen';
  readonly limits: ColdChainLimits;
  /** The last reading this job recorded on this phone, if any. */
  readonly lastReading: number | null;
}

/** Kept at the top of a cold-chain job: the goods' limit and the last box reading. */
export function ColdStrip({ temperature, limits, lastReading }: Props) {
  const styles = useStyles();
  const limit = t('coldStrip.limit', {
    temperature: t(`temperature.${temperature}`),
    max: limits[temperature].maxCelsius,
  });
  const reading =
    lastReading === null
      ? t('coldStrip.noReading')
      : t('coldStrip.reading', { reading: lastReading });
  return (
    <View accessible accessibilityLabel={`${limit}. ${reading}`} style={styles.strip}>
      <Text style={styles.snow}>❄</Text>
      <Text numberOfLines={1} style={styles.limit}>
        {limit}
      </Text>
      <Text numberOfLines={1} style={styles.reading}>
        {reading}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    strip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      backgroundColor: c.coldStrip,
    },
    snow: { color: c.coldStripText, fontSize: text.label },
    limit: { flex: 1, color: c.coldStripText, fontSize: text.small, fontWeight: '700' },
    reading: {
      color: c.coldStripText,
      fontSize: text.small,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      opacity: 0.85,
    },
  }),
);
