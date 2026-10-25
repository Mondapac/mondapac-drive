import { Pressable, StyleSheet, Text, View } from 'react-native';
import { makeStyles, radius, space, text } from '../../ui/theme';

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
  const styles = useStyles();
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

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    group: { gap: space.sm },
    label: { color: c.text, fontSize: text.label, fontWeight: '800' },
    option: {
      minHeight: 56,
      borderWidth: 1.5,
      borderColor: c.border,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      padding: space.md,
      justifyContent: 'center',
    },
    selected: { borderColor: c.primary, borderWidth: 2, backgroundColor: c.successSurface },
    optionLabel: { color: c.text, fontSize: text.label, fontWeight: '600' },
    selectedLabel: { color: c.primary, fontWeight: '800' },
    hint: { color: c.muted, fontSize: text.small, marginTop: space.xs },
  }),
);
