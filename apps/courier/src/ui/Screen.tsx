import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { makeStyles, space, text } from './theme';

interface Props {
  readonly title: string;
  /** A short line above the title, such as the step or the order. */
  readonly eyebrow?: string;
  /** Shown above the title, edge to edge: the cold-chain strip of a job. */
  readonly banner?: ReactNode;
  /** Kept at the bottom, above the home indicator: the screen's main action. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function Screen({ title, eyebrow, banner, footer, children }: Props) {
  const styles = useStyles();
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {banner}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
        </View>
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.background },
    content: { padding: space.md, gap: space.md, paddingBottom: space.lg },
    head: { gap: 2, marginTop: space.sm },
    eyebrow: { color: c.muted, fontSize: text.small, fontWeight: '600' },
    title: { fontSize: text.heading, fontWeight: '800', color: c.text, letterSpacing: -0.4 },
    footer: {
      paddingHorizontal: space.md,
      paddingTop: space.sm,
      paddingBottom: space.sm,
      gap: space.sm,
      backgroundColor: c.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
  }),
);
