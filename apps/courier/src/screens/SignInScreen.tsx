import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { signInInput } from '../api/schemas';
import { t } from '../i18n';
import { useSession } from '../providers';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { TextField } from '../ui/TextField';

/**
 * Placeholder sign-in: a mobile number and a one-time code. Identity (WP2) defines courier
 * sessions; this screen changes with it, the token handling does not.
 */
export function SignInScreen() {
  const { signIn } = useSession();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const input = signInInput.safeParse({ phone: phone.trim(), code: code.trim() });
  const submit = useMutation({
    mutationFn: async () => {
      if (!input.success) throw new Error('invalid');
      await signIn(input.data);
    },
  });

  return (
    <Screen title={t('signIn.title')}>
      <Notice text={t('signIn.placeholderNotice')} />
      <TextField
        label={t('signIn.phone')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoComplete="tel"
        maxLength={20}
      />
      <TextField
        label={t('signIn.code')}
        value={code}
        onChangeText={(value) => setCode(value.replace(/\D/g, ''))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        maxLength={6}
      />
      {(phone || code) && !input.success ? <Notice text={t('signIn.invalid')} /> : null}
      {submit.isError && <Notice tone="danger" text={t('signIn.failed')} />}
      <Button
        label={t('signIn.submit')}
        busy={submit.isPending}
        disabled={!input.success}
        onPress={() => submit.mutate()}
      />
    </Screen>
  );
}
