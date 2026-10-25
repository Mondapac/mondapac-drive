import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import type { DocumentFile } from '../../api/client';
import { t } from '../../i18n';
import { queryKeys, useServices } from '../../providers';
import { Button } from '../../ui/Button';
import { Notice } from '../../ui/Notice';
import { TextField } from '../../ui/TextField';
import { discardDocumentFile, encodeDocumentImage, pickDocumentFile } from './document-file';
import { onboardingError } from './errors';
import { documentLabel } from './labels';
import { expiryInstant, type DocumentSlot } from './onboarding-steps';

interface Props {
  readonly slot: DocumentSlot;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

/**
 * Uploads one document: a photo from the camera or a PDF or image from the phone's files, with
 * its expiry date when it has one. The file on the device is deleted once it is uploaded, when it
 * is replaced and when the form closes, as the proof photos are.
 */
export function DocumentForm({ slot, onDone, onCancel }: Props) {
  const { api, clock } = useServices();
  const queryClient = useQueryClient();
  const [file, setFileState] = useState<DocumentFile | null>(null);
  const [camera, setCamera] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const current = useRef<DocumentFile | null>(null);
  const mounted = useRef(true);

  const setFile = (next: DocumentFile | null) => {
    if (current.current && current.current.uri !== next?.uri) {
      discardDocumentFile(current.current.uri);
    }
    current.current = next;
    setFileState(next);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (current.current) discardDocumentFile(current.current.uri);
      current.current = null;
    };
  }, []);

  /** A file that arrives after the form closed is deleted at once: nothing will upload it. */
  const receive = (picked: DocumentFile) => {
    if (!mounted.current) {
      discardDocumentFile(picked.uri);
      return;
    }
    setFile(picked);
    setCamera(false);
    setProblem(null);
  };

  const choose = async () => {
    const picked = await pickDocumentFile();
    if (picked.kind === 'picked') receive(picked.file);
    else if (picked.kind === 'too-large') setProblem(t('onboarding.upload.tooLarge'));
    else if (picked.kind === 'unsupported') setProblem(t('onboarding.errors.documentMediaType'));
  };

  const upload = useMutation({
    mutationFn: async () => {
      const uploaded = file!;
      const expiresAt = slot.requirement.expires ? expiryInstant(expiry, clock.now()) : null;
      const profile = await api.submitDocument({
        type: slot.requirement.type,
        file: uploaded,
        ...(slot.vehicle ? { vehicleId: slot.vehicle.id } : {}),
        ...(expiresAt?.ok ? { expiresAt: expiresAt.value } : {}),
      });
      // Uploaded: the copy on the phone is no longer needed.
      discardDocumentFile(uploaded.uri);
      if (current.current?.uri === uploaded.uri) current.current = null;
      return profile;
    },
    onSuccess: (profile) => {
      queryClient.setQueryData(queryKeys.profile, profile);
      onDone();
    },
  });

  const submit = () => {
    if (!file) return setProblem(t('onboarding.upload.required'));
    if (slot.requirement.expires) {
      const checked = expiryInstant(expiry, clock.now());
      if (!checked.ok) {
        return setProblem(
          t(
            checked.reason === 'past'
              ? 'onboarding.upload.expiryPast'
              : 'onboarding.upload.expiryInvalid',
          ),
        );
      }
    }
    setProblem(null);
    upload.mutate();
  };

  return (
    <View style={styles.form}>
      <Notice
        text={t('onboarding.upload.title', { document: documentLabel(slot.requirement.type) })}
      />
      {file ? (
        <>
          <Notice text={t('onboarding.upload.fileReady', { name: file.name })} />
          <Button
            label={t('onboarding.upload.change')}
            variant="secondary"
            onPress={() => setFile(null)}
          />
        </>
      ) : camera ? (
        <DocumentCamera onCaptured={receive} onClose={() => setCamera(false)} />
      ) : (
        <>
          <Button label={t('onboarding.upload.takePhoto')} onPress={() => setCamera(true)} />
          <Button
            label={t('onboarding.upload.chooseFile')}
            variant="secondary"
            onPress={() => void choose().catch(() => setProblem(t('errors.generic')))}
          />
        </>
      )}
      {slot.requirement.expires && (
        <TextField
          label={t('onboarding.upload.expiry')}
          value={expiry}
          onChangeText={setExpiry}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
          autoComplete="off"
        />
      )}
      {problem && <Notice tone="warning" text={problem} />}
      {upload.error && <Notice tone="danger" text={onboardingError(upload.error)} />}
      <Button label={t('onboarding.upload.submit')} busy={upload.isPending} onPress={submit} />
      <Button label={t('common.cancel')} variant="secondary" onPress={onCancel} />
    </View>
  );
}

/** The back camera, for a photo of a paper document; the photo is re-encoded before it is kept. */
function DocumentCamera({
  onCaptured,
  onClose,
}: {
  readonly onCaptured: (file: DocumentFile) => void;
  readonly onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <>
        <Notice tone="warning" text={t('onboarding.upload.cameraDenied')} />
        {permission.canAskAgain ? (
          <Button
            label={t('onboarding.upload.allowCamera')}
            onPress={() => void requestPermission()}
          />
        ) : (
          <Button
            label={t('permissions.location.openSettings')}
            onPress={() => void Linking.openSettings()}
          />
        )}
        <Button label={t('common.back')} variant="secondary" onPress={onClose} />
      </>
    );
  }

  const take = async () => {
    if (!camera.current) return;
    setBusy(true);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.9, exif: false });
      onCaptured(await encodeDocumentImage(picture.uri, picture.width));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <CameraView ref={camera} style={styles.camera} facing="back" />
      <Button label={t('onboarding.upload.capture')} busy={busy} onPress={() => void take()} />
      <Button label={t('common.back')} variant="secondary" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 4 },
  camera: { height: 320, borderRadius: 12, overflow: 'hidden' },
});
