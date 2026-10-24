import { getTranslations } from 'next-intl/server';
import { AcceptInvitationFlow } from '../../../src/auth/accept-invitation-flow.tsx';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { panelConfig } from '../../../src/server/config.ts';

export async function generateMetadata() {
  const t = await getTranslations('identity.accept');
  return { title: t('page-title'), referrer: 'no-referrer' };
}

export default async function AcceptInvitationPage() {
  const t = await getTranslations('identity.accept');
  const config = panelConfig();
  return (
    <AuthFrame title={t('title')}>
      <AcceptInvitationFlow
        passwordMin={config.passwordMinLength}
        passwordMax={config.passwordMaxLength}
      />
    </AuthFrame>
  );
}
