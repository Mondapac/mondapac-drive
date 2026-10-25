import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  plateInput,
  type ColdBox,
  type CourierProfile,
  type OnboardingRules,
  type VehicleType,
} from '../../api/schemas';
import { t } from '../../i18n';
import { queryKeys, useServices } from '../../providers';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';
import { TextField } from '../../ui/TextField';
import { Choice } from './Choice';
import { onboardingError } from './errors';
import { vehicleLabel } from './labels';

interface Props {
  readonly rules: OnboardingRules;
  readonly profile: CourierProfile;
}

/**
 * Step 2: the vehicle the courier delivers with. Its capacity is the Market rate card's default
 * for the type (fleet fills it in); a cold box is asked only of a cold-chain courier, for a type
 * the Market lets carry chilled or frozen goods.
 */
export function VehicleStep({ rules, profile }: Props) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const [type, setType] = useState<VehicleType | null>(
    rules.vehicleClasses.length === 1 ? rules.vehicleClasses[0]!.type : null,
  );
  const [plate, setPlate] = useState('');
  const [coldBox, setColdBox] = useState<ColdBox>(profile.coldChainCapable ? 'insulated' : 'none');
  const [tried, setTried] = useState(false);

  const vehicleClass = rules.vehicleClasses.find((vehicle) => vehicle.type === type);
  const carriesCold =
    profile.coldChainCapable &&
    (vehicleClass?.temperatures.some((temperature) => temperature !== 'ambient') ?? false);
  const needsPlate = type !== null && type !== 'bicycle';
  const parsedPlate = plateInput.safeParse(plate);
  const plateProblem = needsPlate && !parsedPlate.success;

  const add = useMutation({
    mutationFn: () =>
      api.addVehicle({
        type: type!,
        ...(needsPlate && parsedPlate.success ? { plate: parsedPlate.data } : {}),
        coldBox: carriesCold ? coldBox : 'none',
      }),
    onSuccess: (updated) => queryClient.setQueryData(queryKeys.profile, updated),
  });

  return (
    <>
      <Choice<VehicleType>
        label={t('onboarding.vehicle.type')}
        value={type}
        onChange={setType}
        options={rules.vehicleClasses.map((vehicle) => ({
          value: vehicle.type,
          label: vehicleLabel(vehicle.type),
        }))}
      />
      {vehicleClass && (
        <Notice
          text={t('onboarding.vehicle.capacity', {
            kg: vehicleClass.maxWeightGrams / 1000,
            litres: vehicleClass.maxVolumeLitres,
          })}
        />
      )}
      {needsPlate && (
        <TextField
          label={t('onboarding.vehicle.plate')}
          value={plate}
          onChangeText={setPlate}
          maxLength={16}
          autoComplete="off"
        />
      )}
      {tried && plateProblem && (
        <Notice tone="warning" text={t('onboarding.vehicle.plateInvalid')} />
      )}
      {carriesCold && (
        <Choice<ColdBox>
          label={t('onboarding.vehicle.coldBox')}
          value={coldBox}
          onChange={setColdBox}
          options={(['insulated', 'refrigerated', 'none'] as const).map((box) => ({
            value: box,
            label: t(`onboarding.vehicle.coldBoxes.${box}`),
          }))}
        />
      )}
      {tried && type === null && (
        <Notice tone="warning" text={t('onboarding.vehicle.chooseType')} />
      )}
      {add.error && <Notice tone="danger" text={onboardingError(add.error)} />}
      <Button
        label={t('onboarding.vehicle.submit')}
        busy={add.isPending}
        onPress={() => {
          setTried(true);
          if (type !== null && !plateProblem) add.mutate();
        }}
      />
    </>
  );
}
