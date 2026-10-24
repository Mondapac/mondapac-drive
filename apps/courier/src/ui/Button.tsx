import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, space } from './theme';

interface Props {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly disabled?: boolean;
  readonly busy?: boolean;
}

export function Button({ label, onPress, variant = 'primary', disabled, busy }: Props) {
  const inactive = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        inactive && styles.inactive,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === 'secondary' ? colors.primary : colors.primaryText} />
      ) : (
        <Text style={[styles.label, variant === 'secondary' && styles.secondaryLabel]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: 10,
    paddingHorizontal: space.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: space.xs,
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: colors.danger },
  inactive: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  label: { color: colors.primaryText, fontSize: 17, fontWeight: '600' },
  secondaryLabel: { color: colors.primary },
});
