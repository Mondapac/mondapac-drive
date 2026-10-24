import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import type { PhotoFile } from '../api/client';
import { t } from '../i18n';
import { compressProofPhoto, discardPhoto } from '../pod/photo';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';

interface Props {
  readonly photo: PhotoFile | null;
  readonly onCaptured: (photo: PhotoFile | null) => void;
}

/** Takes the proof photo with the camera only (no gallery), so it is taken at the door. */
export function CameraCapture({ photo, onCaptured }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <>
        <Notice tone="warning" text={t('proof.cameraDenied')} />
        {permission.canAskAgain ? (
          <Button label={t('proof.allowCamera')} onPress={() => void requestPermission()} />
        ) : (
          <Button
            label={t('permissions.location.openSettings')}
            onPress={() => void Linking.openSettings()}
          />
        )}
      </>
    );
  }

  if (photo) {
    return (
      <>
        <Notice text={t('proof.photoReady')} />
        <Button
          label={t('proof.retakePhoto')}
          variant="secondary"
          onPress={() => {
            discardPhoto(photo.uri);
            onCaptured(null);
          }}
        />
      </>
    );
  }

  const take = async () => {
    if (!camera.current) return;
    setBusy(true);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.8, exif: false });
      onCaptured(await compressProofPhoto(picture.uri, picture.width));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <CameraView ref={camera} style={styles.camera} facing="back" />
      <Button label={t('proof.takePhoto')} busy={busy} onPress={() => void take()} />
    </View>
  );
}

const styles = StyleSheet.create({
  camera: { height: 320, borderRadius: 12, overflow: 'hidden' },
});
