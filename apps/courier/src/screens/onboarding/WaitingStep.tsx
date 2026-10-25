import type { CourierProfile } from '../../api/schemas';
import { t } from '../../i18n';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';
import { DocumentList } from './DocumentList';
import type { SlotStatus } from './onboarding-steps';
import { PayoutSetup } from './PayoutSetup';

interface Props {
  readonly profile: CourierProfile;
  readonly slots: readonly SlotStatus[];
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}

/** Step 4: everything is submitted and an operator reviews it; the app checks back by itself. */
export function WaitingStep({ profile, slots, refreshing, onRefresh }: Props) {
  return (
    <>
      <Notice text={t('onboarding.waiting.body')} />
      <DocumentList slots={slots} />
      {profile.employmentType === 'contractor' && <PayoutSetup />}
      <Button label={t('onboarding.waiting.refresh')} busy={refreshing} onPress={onRefresh} />
    </>
  );
}
