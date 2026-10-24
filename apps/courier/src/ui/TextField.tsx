import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { colors, space } from './theme';

interface Props {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly keyboardType?: KeyboardTypeOptions;
  readonly secureTextEntry?: boolean;
  readonly maxLength?: number;
  readonly autoComplete?: 'tel' | 'one-time-code' | 'off';
}

export function TextField({ label, ...input }: Props) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={styles.input}
        autoCorrect={false}
        autoCapitalize="none"
        placeholderTextColor={colors.muted}
        {...input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginVertical: space.xs },
  label: { color: colors.muted, fontSize: 14, marginBottom: space.xs },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: space.md,
    fontSize: 18,
    color: colors.text,
  },
});
