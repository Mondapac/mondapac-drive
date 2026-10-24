import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FAILURE_REASONS, type FailureReason } from '../api/schemas';
import { t } from '../i18n';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { TextField } from '../ui/TextField';
import { space } from '../ui/theme';

interface Props {
  readonly initialReason?: FailureReason;
  readonly busy: boolean;
  readonly onSubmit: (reason: FailureReason, details: string) => void;
  readonly onCancel: () => void;
}

export function FailureForm({ initialReason, busy, onSubmit, onCancel }: Props) {
  const [reason, setReason] = useState<FailureReason | null>(initialReason ?? null);
  const [details, setDetails] = useState('');
  return (
    <View style={styles.form}>
      <Notice text={t('failure.title')} />
      {FAILURE_REASONS.map((code) => (
        <Button
          key={code}
          label={`${reason === code ? '✓ ' : ''}${t(`failure.reasons.${code}`)}`}
          variant={reason === code ? 'primary' : 'secondary'}
          onPress={() => setReason(code)}
        />
      ))}
      <TextField
        label={t('failure.details')}
        value={details}
        onChangeText={setDetails}
        maxLength={400}
      />
      <Button
        label={t('failure.submit')}
        variant="danger"
        busy={busy}
        disabled={!reason}
        onPress={() => reason && onSubmit(reason, details)}
      />
      <Button label={t('common.cancel')} variant="secondary" onPress={onCancel} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({ form: { gap: space.xs } });
