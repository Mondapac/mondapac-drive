import { StyleSheet, Text, View } from 'react-native';
import { colors, space } from './theme';

type Tone = 'info' | 'warning' | 'danger';

export function Notice({ text, tone = 'info' }: { readonly text: string; readonly tone?: Tone }) {
  return (
    <View accessibilityRole={tone === 'info' ? 'text' : 'alert'} style={[styles.box, styles[tone]]}>
      <Text style={[styles.text, tone === 'danger' && styles.dangerText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 10, padding: space.md, marginVertical: space.xs },
  info: { backgroundColor: colors.surface },
  warning: { backgroundColor: colors.warningSurface },
  danger: { backgroundColor: colors.dangerSurface },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  dangerText: { color: colors.danger, fontWeight: '600' },
});
