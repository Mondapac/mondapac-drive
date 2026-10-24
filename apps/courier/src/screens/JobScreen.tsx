import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import type { JobEvent, ProofInput } from '../api/client';
import type { CourierSettings, FailureReason, Job, Stop } from '../api/schemas';
import { checkReading } from '../domain/cold-chain';
import { canReportFailure, currentStop, nextStep } from '../domain/job-flow';
import { directionsUrl, webDirectionsUrl } from '../domain/navigation';
import { FailureForm } from '../components/FailureForm';
import { ProofOfDelivery, proofReady, type ProofDraft } from '../components/ProofOfDelivery';
import { TemperatureEntry } from '../components/TemperatureEntry';
import { t } from '../i18n';
import { queryKeys, useServices, useSettings } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { colors, space } from '../ui/theme';

interface Props {
  readonly deliveryId: string;
  readonly onDone: () => void;
}

export function JobScreen({ deliveryId, onDone }: Props) {
  const { api } = useServices();
  const settings = useSettings();
  const job = useQuery({
    queryKey: queryKeys.job(deliveryId),
    queryFn: () => api.job(deliveryId),
  });

  if (job.isError) {
    return (
      <Screen title={t('job.title')}>
        <Notice tone="danger" text={errorMessage(job.error)} />
        <Button label={t('common.retry')} onPress={() => void job.refetch()} />
      </Screen>
    );
  }
  if (!job.data || !settings) {
    return (
      <Screen title={t('job.title')}>
        <Text>{t('common.loading')}</Text>
      </Screen>
    );
  }
  return <JobSteps job={job.data} settings={settings} onDone={onDone} />;
}

function JobSteps({
  job,
  settings,
  onDone,
}: {
  readonly job: Job;
  readonly settings: CourierSettings;
  readonly onDone: () => void;
}) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const [reading, setReading] = useState('');
  const [proof, setProof] = useState<ProofDraft>({ kind: 'pin', pin: '' });
  const [failing, setFailing] = useState<{ reason?: FailureReason } | null>(null);

  const record = useMutation({
    mutationFn: async (event: JobEvent) => api.recordEvent(job.id, event),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.job(job.id), updated);
      setReading('');
      setFailing(null);
      if (updated.status === 'DELIVERED' || updated.status === 'DELIVERY_FAILED') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.status });
        void queryClient.invalidateQueries({ queryKey: queryKeys.earnings });
      }
    },
  });

  const deliver = useMutation({
    mutationFn: async (temperatureCelsius: number | undefined) => {
      let input: ProofInput;
      if (proof.kind === 'pin') {
        input = { kind: 'pin', pin: proof.pin };
      } else {
        if (!proof.photo) throw new Error('photo missing');
        const { photoRef } = await api.uploadProofPhoto(job.id, proof.photo);
        input = { kind: 'photo', photoRef };
      }
      return record.mutateAsync({
        type: 'delivered',
        proof: input,
        ...(temperatureCelsius === undefined ? {} : { temperatureCelsius }),
      });
    },
  });

  const step = nextStep(job.status);
  const stopKind = currentStop(job.status);
  const stop = stopKind === 'pickup' ? job.pickup : stopKind === 'dropoff' ? job.dropoff : null;
  const check = checkReading(job.parcel.temperature, reading, settings.coldChain);
  const readingOk = check.kind === 'ok' || check.kind === 'not-required';
  const temperatureCelsius = check.kind === 'ok' ? check.reading : undefined;
  const busy = record.isPending || deliver.isPending;
  const error = record.error ?? deliver.error;

  if (step === 'finished' || step === 'waiting') {
    return (
      <Screen title={t(`job.status.${job.status}`)}>
        <Notice text={t('job.finished')} />
        <Button label={t('job.backHome')} onPress={onDone} />
      </Screen>
    );
  }

  return (
    <Screen title={t(`job.status.${job.status}`)}>
      {stop && <StopCard stop={stop} />}
      {error && <Notice tone="danger" text={errorMessage(error)} />}

      {failing ? (
        <FailureForm
          initialReason={failing.reason}
          busy={busy}
          onCancel={() => setFailing(null)}
          onSubmit={(reason, details) =>
            record.mutate({ type: 'delivery_failed', reason, details })
          }
        />
      ) : (
        <>
          {step === 'arrive_at_pickup' && (
            <Button
              label={t('job.arrivedAtPickup')}
              busy={busy}
              onPress={() => record.mutate({ type: 'arrived_at_pickup' })}
            />
          )}

          {step === 'pick_up' && (
            <>
              <TemperatureEntry
                temperature={job.parcel.temperature}
                limits={settings.coldChain}
                stage="pickup"
                value={reading}
                onChange={setReading}
              />
              <Button
                label={t('job.pickedUp')}
                busy={busy}
                disabled={!readingOk}
                onPress={() =>
                  record.mutate({
                    type: 'picked_up',
                    ...(temperatureCelsius === undefined ? {} : { temperatureCelsius }),
                  })
                }
              />
              {check.kind === 'breach' && (
                <Button
                  label={t('common.callSupport')}
                  variant="secondary"
                  onPress={() => void Linking.openURL(`tel:${settings.supportPhone}`)}
                />
              )}
            </>
          )}

          {step === 'arrive_at_dropoff' && (
            <Button
              label={t('job.arrivedAtDropoff')}
              busy={busy}
              onPress={() => record.mutate({ type: 'arrived_at_dropoff' })}
            />
          )}

          {step === 'deliver' && (
            <>
              <TemperatureEntry
                temperature={job.parcel.temperature}
                limits={settings.coldChain}
                stage="dropoff"
                value={reading}
                onChange={setReading}
              />
              {check.kind !== 'breach' && <ProofOfDelivery draft={proof} onChange={setProof} />}
              {deliver.isPending && proof.kind === 'photo' && <Text>{t('proof.uploading')}</Text>}
              <Button
                label={t('job.deliver')}
                busy={busy}
                disabled={!readingOk || !proofReady(proof)}
                onPress={() => deliver.mutate(temperatureCelsius)}
              />
            </>
          )}

          {canReportFailure(job.status) && (
            <Button
              label={t('job.reportFailure')}
              variant="danger"
              disabled={busy}
              onPress={() =>
                setFailing(check.kind === 'breach' ? { reason: 'cold_chain_breach' } : {})
              }
            />
          )}
        </>
      )}
    </Screen>
  );
}

function StopCard({ stop }: { readonly stop: Stop }) {
  const navigate = () => {
    const destination = stop.point ?? stop.address;
    Linking.openURL(directionsUrl(destination, Platform.OS)).catch(() =>
      Linking.openURL(webDirectionsUrl(destination)),
    );
  };
  return (
    <View style={styles.stop}>
      <Text style={styles.address}>{stop.address}</Text>
      <Text style={styles.contact}>{stop.contactName}</Text>
      {stop.notes ? (
        <Text style={styles.notes}>{t('job.notes', { notes: stop.notes })}</Text>
      ) : null}
      <Button label={t('job.navigate')} variant="secondary" onPress={navigate} />
      <Button
        label={t('job.callContact', { name: stop.contactName })}
        variant="secondary"
        onPress={() => void Linking.openURL(`tel:${stop.contactPhone}`)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stop: {
    borderRadius: 12,
    backgroundColor: colors.surface,
    padding: space.md,
    gap: space.xs,
  },
  address: { fontSize: 18, fontWeight: '600', color: colors.text },
  contact: { fontSize: 15, color: colors.muted },
  notes: { fontSize: 15, color: colors.text },
});
