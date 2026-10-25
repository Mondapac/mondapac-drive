import { StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { makeStyles, radius } from './theme';

/** How far through a delivery the courier is, as filled segments. */
export function StepBar({ step, total }: { readonly step: number; readonly total: number }) {
  const styles = useStyles();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('job.progress', { step, total })}
      accessibilityValue={{ min: 0, max: total, now: step }}
      style={styles.bar}
    >
      {Array.from({ length: total }, (_, index) => (
        <View key={index} style={[styles.segment, index < step && styles.done]} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    bar: { flexDirection: 'row', gap: 4 },
    segment: { flex: 1, height: 4, borderRadius: radius.pill, backgroundColor: c.border },
    done: { backgroundColor: c.primary },
  }),
);
