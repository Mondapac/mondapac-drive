import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { signInInput } from '../api/schemas';
import { t, type TranslationKey } from '../i18n';
import { useSession } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { TextField } from '../ui/TextField';

/** Identity's refusals of a sign-in, in the courier's words. */
const REFUSALS: Readonly<Record<string, TranslationKey>> = {
  'credentials.invalid': 'signIn.failed',
  'account.disabled': 'signIn.disabled',
  'request.throttled': 'signIn.throttled',
};

function refusal(error: unknown): string {
  const key = error instanceof ApiError ? REFUSALS[error.code] : undefined;
  return key ? t(key) : errorMessage(error);
}

/** Courier sign-in with the email and password of the account an operator invited. */
export function SignInScreen() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const input = signInInput.safeParse({ email: email.trim(), password });
  const submit = useMutation({
    mutationFn: async () => {
      if (!input.success) throw new Error('invalid');
      await signIn(input.data);
    },
    // The password never stays on screen after an attempt.
    onSettled: () => setPassword(''),
  });

  return (
    <Screen title={t('signIn.title')}>
      <TextField
        label={t('signIn.email')}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        maxLength={254}
      />
      <TextField
        label={t('signIn.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        maxLength={256}
      />
      {email && password && !input.success ? <Notice text={t('signIn.invalid')} /> : null}
      {submit.isError && <Notice tone="danger" text={refusal(submit.error)} />}
      <Button
        label={t('signIn.submit')}
        busy={submit.isPending}
        disabled={!input.success}
        onPress={() => submit.mutate()}
      />
    </Screen>
  );
}
