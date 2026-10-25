import { StyleSheet, Text, View } from 'react-native';
import { makeStyles, radius, space, text } from './theme';

export type ChipTone = 'neutral' | 'success' | 'cold' | 'warning' | 'danger';

/** A short state label: online, chilled, 2 of 3. */
export function Chip({
  label,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly tone?: ChipTone;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.chip, styles[tone]]}>
      {tone === 'success' && <View style={styles.dot} />}
      <Text style={[styles.text, styles[`${tone}Text`]]}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      paddingHorizontal: 10,
      paddingVertical: space.xs,
    },
    dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.success },
    neutral: { backgroundColor: c.raised },
    success: { backgroundColor: c.successSurface },
    cold: { backgroundColor: c.coldSurface },
    warning: { backgroundColor: c.warningSurface },
    danger: { backgroundColor: c.dangerSurface },
    text: { fontSize: text.caption, fontWeight: '700', color: c.text },
    neutralText: {},
    successText: { color: c.success },
    coldText: { color: c.cold },
    warningText: { color: c.warning },
    dangerText: { color: c.danger },
  }),
);
