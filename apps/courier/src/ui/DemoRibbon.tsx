import { StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { env } from '../platform/env';
import { makeStyles, space, text } from './theme';

/**
 * A demo build runs on sample data; this strip says so at the top of every screen, so nobody
 * mistakes a demo delivery for a real one. Nothing in any other build.
 */
export function DemoRibbon({ demo = env.demo }: { readonly demo?: boolean }) {
  const styles = useStyles();
  if (!demo) return null;
  return (
    <View style={styles.ribbon} accessibilityRole="text">
      <Text style={styles.label}>{t('demo.ribbon')}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    ribbon: {
      backgroundColor: c.warningSurface,
      paddingVertical: space.xs,
      paddingHorizontal: space.md,
      alignItems: 'center',
    },
    label: { color: c.warning, fontSize: text.caption, fontWeight: '700' },
  }),
);
