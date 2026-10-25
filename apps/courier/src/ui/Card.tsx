import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { makeStyles, radius, space } from './theme';

/** A surface that sets one group apart: a stop, a total, the offer sheet. */
export function Card({
  children,
  label,
  raised,
}: {
  readonly children: ReactNode;
  /** Read out as one name for the group, such as "New delivery offer". */
  readonly label?: string;
  /** Lifted with a shadow, for the sheet that holds the screen's decision. */
  readonly raised?: boolean;
}) {
  const styles = useStyles();
  return (
    <View accessibilityLabel={label} style={[styles.card, raised && styles.raised]}>
      {children}
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    card: { backgroundColor: c.surface, borderRadius: radius.lg, padding: space.md, gap: space.sm },
    raised: {
      shadowColor: c.shadow,
      shadowOpacity: c.scheme === 'dark' ? 0.5 : 0.12,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 6,
    },
  }),
);
