import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { makeStyles, radius, space, text, useTheme } from './theme';

interface Props {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly secureTextEntry?: boolean;
  readonly maxLength?: number;
  readonly autoComplete?: 'email' | 'password' | 'off';
  /** Large centred digits: a PIN or a temperature. */
  readonly large?: boolean;
}

export function TextField({ label, large, ...input }: Props) {
  const styles = useStyles();
  const palette = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[styles.input, large && styles.large]}
        autoCorrect={false}
        autoCapitalize="none"
        placeholderTextColor={palette.muted}
        selectionColor={palette.primary}
        keyboardAppearance={palette.scheme}
        {...input}
      />
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    field: { gap: space.xs },
    label: { color: c.muted, fontSize: text.small, fontWeight: '600' },
    input: {
      minHeight: 54,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      fontSize: 18,
      color: c.text,
    },
    large: {
      minHeight: 64,
      fontSize: 30,
      fontWeight: '800',
      textAlign: 'center',
      letterSpacing: 4,
      fontVariant: ['tabular-nums'],
    },
  }),
);
