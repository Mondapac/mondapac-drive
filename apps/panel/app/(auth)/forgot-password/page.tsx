import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { ForgotPasswordForm } from '../../../src/auth/forgot-password-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('identity.forgot-password');
  return { title: t('page-title') };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('identity.forgot-password');
  return (
    <AuthFrame title={t('title')}>
      <ForgotPasswordForm />
    </AuthFrame>
  );
}
