import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { ApiError, type JobEvent, type ProofInput } from '../api/client';
import type { CourierSettings, FailureReason, Job, Stop } from '../api/schemas';
import { checkReading, needsColdChain } from '../domain/cold-chain';
import { canReportFailure, currentStop, nextStep } from '../domain/job-flow';
import { directionsUrl, webDirectionsUrl } from '../domain/navigation';
import { ColdStrip } from '../components/ColdStrip';
import { FailureForm } from '../components/FailureForm';
import { ProofOfDelivery, proofReady, type ProofDraft } from '../components/ProofOfDelivery';
import { TemperatureEntry } from '../components/TemperatureEntry';
import { discardPhoto } from '../pod/photo';
import { t } from '../i18n';
import { queryKeys, useServices, useSettings } from '../providers';
import { Button } from '../ui/Button';
import { errorMessage } from '../ui/errors';
import { Notice } from '../ui/Notice';
import { Screen } from '../ui/Screen';
import { Card } from '../ui/Card';
import { SlideToConfirm } from '../ui/SlideToConfirm';
import { StepBar } from '../ui/StepBar';
import { makeStyles, radius, space, text } from '../ui/theme';

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
        <Notice text={t('common.loading')} />
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
  const [pinLocked, setPinLocked] = useState(false);
  // The last box reading this phone recorded for the job, shown in the cold-chain strip.
  const [lastReading, setLastReading] = useState<number | null>(null);
  // The photo already uploaded: a retry after a refused event sends its reference again, since
  // the file itself is deleted once it is on the server.
  const uploaded = useRef<{ readonly uri: string; readonly photoRef: string } | null>(null);
  const latestProof = useRef(proof);
  latestProof.current = proof;

  // A photo taken but never uploaded is deleted when the courier leaves the job.
  useEffect(
    () => () => {
      const left = latestProof.current;
      if (left.kind === 'photo' && left.photo) discardPhoto(left.photo.uri);
    },
    [],
  );

  // A photo the draft no longer holds (retaken, or the courier switched to the PIN) is deleted.
  const changeProof = (next: ProofDraft) => {
    const previous = latestProof.current;
    const kept = next.kind === 'photo' ? next.photo?.uri : undefined;
    if (previous.kind === 'photo' && previous.photo && previous.photo.uri !== kept) {
      discardPhoto(previous.photo.uri);
    }
    latestProof.current = next;
    setProof(next);
  };

  const record = useMutation({
    mutationFn: async (event: JobEvent) => api.recordEvent(job.id, event),
    onSuccess: (updated, event) => {
      queryClient.setQueryData(queryKeys.job(job.id), updated);
      if ('temperatureCelsius' in event && event.temperatureCelsius !== undefined) {
        setLastReading(event.temperatureCelsius);
      }
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
        const photo = proof.photo;
        if (!photo) throw new Error('photo missing');
        if (uploaded.current?.uri !== photo.uri) {
          const { photoRef } = await api.uploadProofPhoto(job.id, photo);
          uploaded.current = { uri: photo.uri, photoRef };
          discardPhoto(photo.uri);
        }
        input = { kind: 'photo', photoRef: uploaded.current.photoRef };
      }
      return record.mutateAsync({
        type: 'delivered',
        proof: input,
        ...(temperatureCelsius === undefined ? {} : { temperatureCelsius }),
      });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'delivery.pin-locked') {
        // PIN entry is closed for this delivery: the photo is the only proof left.
        setPinLocked(true);
        changeProof({ kind: 'photo', photo: null });
      } else if (error.code === 'delivery.proof-photo-unknown') {
        // The server does not know the reference, and the file is gone: take the photo again.
        uploaded.current = null;
        changeProof({ kind: 'photo', photo: null });
      }
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
      <Screen
        title={t(`job.status.${job.status}`)}
        footer={<Button label={t('job.backHome')} onPress={onDone} />}
      >
        <Notice tone={job.status === 'DELIVERED' ? 'success' : 'info'} text={t('job.finished')} />
      </Screen>
    );
  }

  const cold = needsColdChain(job.parcel.temperature) ? job.parcel.temperature : null;
  const footer = failing ? null : (
    <>
      {step === 'arrive_at_pickup' && (
        <SlideToConfirm
          label={t('job.arrivedAtPickup')}
          busy={busy}
          onConfirm={() => record.mutate({ type: 'arrived_at_pickup' })}
        />
      )}
      {step === 'pick_up' && (
        <SlideToConfirm
          label={t('job.pickedUp')}
          busy={busy}
          disabled={!readingOk}
          onConfirm={() =>
            record.mutate({
              type: 'picked_up',
              ...(temperatureCelsius === undefined ? {} : { temperatureCelsius }),
            })
          }
        />
      )}
      {step === 'arrive_at_dropoff' && (
        <SlideToConfirm
          label={t('job.arrivedAtDropoff')}
          busy={busy}
          onConfirm={() => record.mutate({ type: 'arrived_at_dropoff' })}
        />
      )}
      {step === 'deliver' && (
        // The PIN or photo is the confirmation here, so a plain button completes the delivery.
        <Button
          label={t('job.deliver')}
          busy={busy}
          disabled={!readingOk || !proofReady(proof)}
          onPress={() => deliver.mutate(temperatureCelsius)}
        />
      )}
      {canReportFailure(job.status) && (
        <Button
          label={t('job.reportFailure')}
          variant="quiet"
          size="small"
          disabled={busy}
          onPress={() => setFailing(check.kind === 'breach' ? { reason: 'cold_chain_breach' } : {})}
        />
      )}
    </>
  );

  return (
    <Screen
      title={t(`job.status.${job.status}`)}
      eyebrow={t('job.progress', { step: STEP_NUMBER[step], total: STEPS })}
      banner={
        cold && (
          <ColdStrip temperature={cold} limits={settings.coldChain} lastReading={lastReading} />
        )
      }
      footer={footer}
    >
      <StepBar step={STEP_NUMBER[step]} total={STEPS} />
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
          {(step === 'pick_up' || step === 'deliver') && (
            <TemperatureEntry
              temperature={job.parcel.temperature}
              limits={settings.coldChain}
              stage={step === 'pick_up' ? 'pickup' : 'dropoff'}
              value={reading}
              onChange={setReading}
            />
          )}
          {step === 'pick_up' && check.kind === 'breach' && (
            <Button
              label={t('common.callSupport')}
              variant="secondary"
              onPress={() => void Linking.openURL(`tel:${settings.supportPhone}`)}
            />
          )}
          {step === 'deliver' && check.kind !== 'breach' && (
            <ProofOfDelivery draft={proof} onChange={changeProof} pinLocked={pinLocked} />
          )}
          {deliver.isPending && proof.kind === 'photo' && <Notice text={t('proof.uploading')} />}
        </>
      )}
    </Screen>
  );
}

const STEPS = 4;
const STEP_NUMBER = { arrive_at_pickup: 1, pick_up: 2, arrive_at_dropoff: 3, deliver: 4 } as const;

function StopCard({ stop }: { readonly stop: Stop }) {
  const styles = useStyles();
  const navigate = () => {
    const destination = stop.point ?? stop.address;
    Linking.openURL(directionsUrl(destination, Platform.OS)).catch(() =>
      Linking.openURL(webDirectionsUrl(destination)),
    );
  };
  return (
    <Card raised>
      <Text style={styles.address}>{stop.address}</Text>
      <Text style={styles.contact}>{stop.contactName}</Text>
      {stop.notes ? (
        <Text style={styles.notes}>{t('job.notes', { notes: stop.notes })}</Text>
      ) : null}
      <View style={styles.actions}>
        <Button label={t('job.navigate')} size="small" grow onPress={navigate} />
        <Button
          label={t('job.callContact', { name: stop.contactName })}
          variant="secondary"
          size="small"
          grow
          onPress={() => void Linking.openURL(`tel:${stop.contactPhone}`)}
        />
      </View>
    </Card>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    address: { fontSize: text.title, fontWeight: '800', color: c.text, letterSpacing: -0.2 },
    contact: { fontSize: text.body, color: c.muted },
    notes: {
      fontSize: text.body,
      color: c.text,
      backgroundColor: c.raised,
      borderRadius: radius.sm,
      padding: space.sm,
    },
    actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  }),
);
