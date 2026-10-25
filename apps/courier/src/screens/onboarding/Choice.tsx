import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, space } from '../../ui/theme';

export interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

interface Props<T extends string> {
  readonly label: string;
  readonly options: readonly ChoiceOption<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
}

/** A labelled group of radio buttons, one tap target per option. */
export function Choice<T extends string>({ label, options, value, onChange }: Props<T>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityHint={option.hint}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            style={[styles.option, selected && styles.selected]}
          >
            <Text style={[styles.optionLabel, selected && styles.selectedLabel]}>
              {option.label}
            </Text>
            {option.hint && <Text style={styles.hint}>{option.hint}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { marginVertical: space.xs, gap: space.xs },
  label: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: space.xs },
  option: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: space.md,
    justifyContent: 'center',
  },
  selected: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.surface },
  optionLabel: { color: colors.text, fontSize: 17 },
  selectedLabel: { color: colors.primary, fontWeight: '600' },
  hint: { color: colors.muted, fontSize: 14, marginTop: space.xs },
});
