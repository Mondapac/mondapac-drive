import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { ResetPasswordForm } from '../../../src/auth/reset-password-form.tsx';
import { panelConfig } from '../../../src/server/config.ts';

export async function generateMetadata() {
  const t = await getTranslations('identity.reset-password');
  return { title: t('page-title'), referrer: 'no-referrer' };
}

export default async function ResetPasswordPage() {
  const t = await getTranslations('identity.reset-password');
  const config = panelConfig();
  return (
    <AuthFrame title={t('title')}>
      <ResetPasswordForm
        passwordMin={config.passwordMinLength}
        passwordMax={config.passwordMaxLength}
      />
    </AuthFrame>
  );
}
