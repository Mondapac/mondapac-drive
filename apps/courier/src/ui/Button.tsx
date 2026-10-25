import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { makeStyles, radius, space, text, useTheme } from './theme';

interface Props {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  readonly size?: 'large' | 'small';
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /** Takes an equal share of a row of buttons. */
  readonly grow?: boolean;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'large',
  disabled,
  busy,
  grow,
}: Props) {
  const styles = useStyles();
  const palette = useTheme();
  const inactive = disabled === true || busy === true;
  const filled = variant === 'primary' || variant === 'danger';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'small' && styles.small,
        styles[variant],
        grow && styles.grow,
        inactive && styles.inactive,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={filled ? palette.primaryText : palette.text} />
      ) : (
        <Text
          numberOfLines={2}
          style={[
            styles.label,
            size === 'small' && styles.smallLabel,
            variant === 'secondary' && styles.secondaryLabel,
            variant === 'danger' && styles.dangerLabel,
            variant === 'quiet' && styles.quietLabel,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    base: {
      minHeight: 54,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    small: { minHeight: 44 },
    grow: { flex: 1 },
    primary: { backgroundColor: c.primary },
    secondary: { backgroundColor: c.raised },
    danger: { backgroundColor: c.danger },
    quiet: { backgroundColor: 'transparent' },
    inactive: { opacity: 0.4 },
    pressed: { opacity: 0.8 },
    label: { color: c.primaryText, fontSize: text.label, fontWeight: '800', textAlign: 'center' },
    smallLabel: { fontSize: text.body, fontWeight: '700' },
    secondaryLabel: { color: c.text },
    dangerLabel: { color: c.scheme === 'dark' ? '#1B0605' : '#FFFFFF' },
    quietLabel: { color: c.danger, fontWeight: '700' },
  }),
);
