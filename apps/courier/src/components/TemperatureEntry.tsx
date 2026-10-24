import type { ColdChainLimits, Temperature } from '../api/schemas';
import { checkReading } from '../domain/cold-chain';
import { t } from '../i18n';
import { Notice } from '../ui/Notice';
import { TextField } from '../ui/TextField';

interface Props {
  readonly temperature: Temperature;
  readonly limits: ColdChainLimits;
  readonly stage: 'pickup' | 'dropoff';
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The cold-chain reading at pickup or drop-off, checked against the Market's limit as typed. */
export function TemperatureEntry({ temperature, limits, stage, value, onChange }: Props) {
  const check = checkReading(temperature, value, limits);
  if (check.kind === 'not-required') return null;
  const goods = t(`temperature.${temperature as 'chilled' | 'frozen'}`);
  return (
    <>
      <Notice text={t('coldChain.limit', { temperature: goods, max: check.maxCelsius })} />
      <TextField
        label={t('coldChain.label')}
        value={value}
        onChangeText={onChange}
        keyboardType="numbers-and-punctuation"
        maxLength={6}
      />
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
    </>
  );
}
