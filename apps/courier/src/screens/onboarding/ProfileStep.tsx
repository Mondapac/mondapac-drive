import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { EmploymentType, OnboardingRules } from '../../api/schemas';
import { t } from '../../i18n';
import { queryKeys, useServices } from '../../providers';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';
import { Choice } from './Choice';
import { onboardingError } from './errors';
import { areaLabel } from './labels';

/** Step 1: how the courier works, where, and whether they carry cold-chain goods. */
export function ProfileStep({ rules }: { readonly rules: OnboardingRules }) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const areas = rules.serviceAreas;
  const [employmentType, setEmploymentType] = useState<EmploymentType | null>(null);
  const [serviceAreaCode, setServiceArea] = useState<string | null>(
    areas.length === 1 ? areas[0]!.code : null,
  );
  const [coldChain, setColdChain] = useState<'yes' | 'no' | null>(null);
  const [tried, setTried] = useState(false);

  const apply = useMutation({
    mutationFn: () =>
      api.applyAsCourier({
        employmentType: employmentType!,
        serviceAreaCode: serviceAreaCode!,
        coldChainCapable: coldChain === 'yes',
      }),
    onSuccess: (profile) => queryClient.setQueryData(queryKeys.profile, profile),
  });

  const complete = employmentType !== null && serviceAreaCode !== null && coldChain !== null;

  return (
    <>
      <Choice<EmploymentType>
        label={t('onboarding.profile.employmentType')}
        value={employmentType}
        onChange={setEmploymentType}
        options={[
          {
            value: 'employee',
            label: t('onboarding.profile.employee'),
            hint: t('onboarding.profile.employeeHint'),
          },
          {
            value: 'contractor',
            label: t('onboarding.profile.contractor'),
            hint: t('onboarding.profile.contractorHint'),
          },
        ]}
      />
      <Choice
        label={t('onboarding.profile.serviceArea')}
        value={serviceAreaCode}
        onChange={setServiceArea}
        options={areas.map((area) => ({ value: area.code, label: areaLabel(area.code) }))}
      />
      <Choice<'yes' | 'no'>
        label={t('onboarding.profile.coldChain')}
        value={coldChain}
        onChange={setColdChain}
        options={[
          {
            value: 'yes',
            label: t('onboarding.profile.yes'),
            hint: t('onboarding.profile.coldChainHint'),
          },
          { value: 'no', label: t('onboarding.profile.no') },
        ]}
      />
      {tried && !complete && <Notice tone="warning" text={t('onboarding.profile.incomplete')} />}
      {apply.error && <Notice tone="danger" text={onboardingError(apply.error)} />}
      <Button
        label={t('onboarding.profile.submit')}
        busy={apply.isPending}
        onPress={() => {
          setTried(true);
          if (complete) apply.mutate();
        }}
      />
    </>
  );
}
