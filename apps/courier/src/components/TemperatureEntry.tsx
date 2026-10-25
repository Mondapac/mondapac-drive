import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ColdChainLimits, Temperature } from '../api/schemas';
import { checkReading } from '../domain/cold-chain';
import { t } from '../i18n';
import { Card } from '../ui/Card';
import { Notice } from '../ui/Notice';
import { TextField } from '../ui/TextField';
import { makeStyles, space, text } from '../ui/theme';

interface Props {
  readonly temperature: Temperature;
  readonly limits: ColdChainLimits;
  readonly stage: 'pickup' | 'dropoff';
  readonly value: string;
  readonly onChange: (value: string) => void;
}

const STEP = 0.5;

/** The cold-chain reading at pickup or drop-off, checked against the Market's limit as typed. */
export function TemperatureEntry({ temperature, limits, stage, value, onChange }: Props) {
  const styles = useStyles();
  const check = checkReading(temperature, value, limits);
  if (check.kind === 'not-required') return null;
  const goods = t(`temperature.${temperature as 'chilled' | 'frozen'}`);
  // The steppers adjust a reading already typed; they never suggest one.
  const reading = check.kind === 'ok' || check.kind === 'breach' ? check.reading : null;
  const nudge = (by: number) => {
    if (reading !== null) onChange(String(Math.round((reading + by) * 10) / 10));
  };
  return (
    <Card>
      <Text style={styles.title}>{t('coldChain.title')}</Text>
      <Text style={styles.limit}>
        {t('coldChain.limit', { temperature: goods, max: check.maxCelsius })}
      </Text>
      <View style={styles.entry}>
        <Stepper
          label={t('coldChain.lower')}
          glyph="−"
          disabled={reading === null}
          onPress={() => nudge(-STEP)}
        />
        <View style={styles.field}>
          <TextField
            label={t('coldChain.label')}
            value={value}
            onChangeText={onChange}
            keyboardType="numbers-and-punctuation"
            maxLength={6}
            large
          />
        </View>
        <Stepper
          label={t('coldChain.higher')}
          glyph="+"
          disabled={reading === null}
          onPress={() => nudge(STEP)}
        />
      </View>
      {check.kind === 'ok' && <Notice tone="success" text={t('coldChain.within')} />}
      {check.kind === 'invalid' && <Notice tone="warning" text={t('coldChain.outOfRange')} />}
      {check.kind === 'breach' && (
        <>
          <Notice
            tone="danger"
            text={t('coldChain.breach', { reading: check.reading, max: check.maxCelsius })}
          />
          <Notice
            tone="warning"
            text={t(stage === 'pickup' ? 'coldChain.breachAtPickup' : 'coldChain.breachAtDropoff')}
          />
        </>
      )}
    </Card>
  );
}

function Stepper({
  label,
  glyph,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.stepper, disabled && styles.off, pressed && styles.pressed]}
    >
      <Text style={styles.glyph}>{glyph}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    title: { color: c.text, fontSize: text.label, fontWeight: '800' },
    limit: { color: c.muted, fontSize: text.body },
    entry: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
    field: { flex: 1 },
    stepper: {
      width: 56,
      height: 64,
      borderRadius: 32,
      backgroundColor: c.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    off: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    glyph: { color: c.text, fontSize: 28, fontWeight: '700' },
  }),
);
