import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { t, type TranslationKey } from '../../i18n';
import { queryKeys, useServices, useSession, useSettings } from '../../providers';
import { Button } from '../../ui/Button';
import { errorMessage } from '../../ui/errors';
import { Notice } from '../../ui/Notice';
import { Screen } from '../../ui/Screen';
import { StepBar } from '../../ui/StepBar';
import { DocumentForm } from './DocumentForm';
import { DocumentList } from './DocumentList';
import { purgeDocumentCache } from './document-file';
import { onboardingStep, STEPS, type DocumentSlot, type OnboardingStep } from './onboarding-steps';
import { PayoutSetup } from './PayoutSetup';
import { ProfileStep } from './ProfileStep';
import { VehicleStep } from './VehicleStep';
import { WaitingStep } from './WaitingStep';

/** How often the waiting screen asks whether an operator has approved the courier. */
export const APPROVAL_POLL_MS = 30_000;

const TITLES: Readonly<Record<OnboardingStep['kind'], TranslationKey>> = {
  profile: 'onboarding.profile.title',
  vehicle: 'onboarding.vehicle.title',
  documents: 'onboarding.documents.title',
  waiting: 'onboarding.waiting.title',
  ready: 'onboarding.title',
  blocked: 'onboarding.title',
};

interface Props {
  /** The courier may work: the app goes on to the home screen. */
  readonly onReady: () => void;
}

/**
 * From invitation to ready: profile, vehicle, documents, then waiting for an operator. The step
 * comes from the server's profile every time, so the app resumes where the courier left off.
 */
export function OnboardingScreen({ onReady }: Props) {
  const { api, clock } = useServices();
  const { signOut } = useSession();
  const settings = useSettings();
  const [uploading, setUploading] = useState<DocumentSlot | null>(null);

  // A picked file left behind by a crash or a kill goes before anything else is picked.
  useEffect(purgeDocumentCache, []);

  const rules = useQuery({
    queryKey: queryKeys.onboardingRules,
    queryFn: () => api.onboardingRules(),
    staleTime: 60 * 60 * 1000,
  });
  const profile = useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => api.profile(),
    refetchInterval: (query) =>
      query.state.data?.status === 'applicant' ? APPROVAL_POLL_MS : false,
  });

  const step =
    rules.data && profile.isSuccess ? onboardingStep(profile.data, rules.data, clock.now()) : null;
  // An approved courier goes on even if the rules cannot be read: home needs none of them.
  const ready = profile.data?.status === 'active';

  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  const error = ready ? null : (profile.error ?? rules.error);
  const signOutButton = (
    <Button label={t('onboarding.signOut')} variant="secondary" onPress={() => void signOut()} />
  );

  if (error) {
    return (
      <Screen title={t('onboarding.title')}>
        <Notice tone="danger" text={errorMessage(error)} />
        <Button
          label={t('common.retry')}
          onPress={() => {
            void profile.refetch();
            void rules.refetch();
          }}
        />
        {signOutButton}
      </Screen>
    );
  }

  if (!profile.isSuccess || rules.isPending || ready) {
    return (
      <Screen title={t('onboarding.title')}>
        <Notice text={t('onboarding.loading')} />
      </Screen>
    );
  }

  const support = settings?.supportPhone;
  const callSupport = support ? (
    <Button
      label={t('common.callSupport')}
      variant="secondary"
      onPress={() => void Linking.openURL(`tel:${support}`)}
    />
  ) : null;

  // The API does not send the Market's rules yet: an operator finishes the set-up.
  if (!step) {
    return (
      <Screen title={t('onboarding.title')}>
        <Notice tone="warning" text={t('onboarding.unavailable')} />
        {callSupport}
        {signOutButton}
      </Screen>
    );
  }

  if (step.kind === 'blocked') {
    return (
      <Screen title={t('onboarding.title')}>
        <Notice tone="danger" text={t(`onboarding.blocked.${step.standing}`)} />
        {callSupport}
        {signOutButton}
      </Screen>
    );
  }

  // An active courier is already on the way home (above).
  if (step.kind === 'ready') return null;

  const index = STEPS.indexOf(step.kind);
  return (
    <Screen
      title={t(TITLES[step.kind])}
      eyebrow={
        index >= 0 ? t('onboarding.stepOf', { step: index + 1, total: STEPS.length }) : undefined
      }
    >
      {index >= 0 && <StepBar step={index + 1} total={STEPS.length} />}
      {step.kind === 'profile' && <ProfileStep rules={rules.data!} />}
      {step.kind === 'vehicle' && profile.data && (
        <VehicleStep rules={rules.data!} profile={profile.data} />
      )}
      {step.kind === 'documents' &&
        (uploading ? (
          <DocumentForm
            slot={uploading}
            onDone={() => setUploading(null)}
            onCancel={() => setUploading(null)}
          />
        ) : (
          <>
            <Notice text={t('onboarding.documents.intro')} />
            <DocumentList slots={step.slots} onUpload={setUploading} />
            {profile.data?.employmentType === 'contractor' && <PayoutSetup />}
          </>
        ))}
      {step.kind === 'waiting' && profile.data && (
        <WaitingStep
          profile={profile.data}
          slots={step.slots}
          refreshing={profile.isFetching}
          onRefresh={() => void profile.refetch()}
        />
      )}
      {callSupport}
      {signOutButton}
    </Screen>
  );
}
