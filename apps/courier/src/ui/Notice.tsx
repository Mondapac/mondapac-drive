import { StyleSheet, Text, View } from 'react-native';
import { makeStyles, radius, space, text } from './theme';

type Tone = 'info' | 'warning' | 'danger' | 'success';

export function Notice({
  text: message,
  tone = 'info',
}: {
  readonly text: string;
  readonly tone?: Tone;
}) {
  const styles = useStyles();
  return (
    <View
      accessibilityRole={tone === 'warning' || tone === 'danger' ? 'alert' : 'text'}
      style={[styles.box, styles[tone]]}
    >
      <View style={[styles.dot, styles[`${tone}Dot`]]} />
      <Text style={[styles.text, styles[`${tone}Text`]]}>{message}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    box: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.sm,
      borderRadius: radius.md,
      padding: space.md,
    },
    dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
    info: { backgroundColor: c.raised },
    warning: { backgroundColor: c.warningSurface },
    danger: { backgroundColor: c.dangerSurface },
    success: { backgroundColor: c.successSurface },
    infoDot: { backgroundColor: c.muted },
    warningDot: { backgroundColor: c.warning },
    dangerDot: { backgroundColor: c.danger },
    successDot: { backgroundColor: c.success },
    text: { flex: 1, color: c.text, fontSize: text.body, lineHeight: 21 },
    infoText: {},
    warningText: { color: c.warning, fontWeight: '600' },
    dangerText: { color: c.danger, fontWeight: '700' },
    successText: { color: c.success, fontWeight: '700' },
  }),
);
