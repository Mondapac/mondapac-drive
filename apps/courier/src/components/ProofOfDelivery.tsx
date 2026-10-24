import { StyleSheet, Text, View } from 'react-native';
import type { PhotoFile } from '../api/client';
import { pinInput } from '../api/schemas';
import { t } from '../i18n';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { TextField } from '../ui/TextField';
import { colors, space } from '../ui/theme';
import { CameraCapture } from './CameraCapture';

export type ProofDraft =
  | { readonly kind: 'pin'; readonly pin: string }
  | { readonly kind: 'photo'; readonly photo: PhotoFile | null };

/** Whether the draft can be sent: a well-formed PIN or a taken photo. */
export function proofReady(draft: ProofDraft): boolean {
  return draft.kind === 'pin' ? pinInput.safeParse(draft.pin).success : draft.photo !== null;
}

interface Props {
  readonly draft: ProofDraft;
  readonly onChange: (draft: ProofDraft) => void;
  /** The server closed PIN entry for this delivery (too many wrong PINs): photo only. */
  readonly pinLocked?: boolean;
}

export function ProofOfDelivery({ draft, onChange, pinLocked = false }: Props) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{t('proof.title')}</Text>
      <View style={styles.modes}>
        {!pinLocked && (
          <View style={styles.mode}>
            <Button
              label={t('proof.byPin')}
              variant={draft.kind === 'pin' ? 'primary' : 'secondary'}
              onPress={() => onChange({ kind: 'pin', pin: '' })}
            />
          </View>
        )}
        <View style={styles.mode}>
          <Button
            label={t('proof.byPhoto')}
            variant={draft.kind === 'photo' ? 'primary' : 'secondary'}
            onPress={() => onChange({ kind: 'photo', photo: null })}
          />
        </View>
      </View>
      {draft.kind === 'pin' ? (
        <>
          <TextField
            label={t('proof.pinLabel')}
            value={draft.pin}
            onChangeText={(pin) => onChange({ kind: 'pin', pin: pin.replace(/\D/g, '') })}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={8}
            autoComplete="off"
          />
          {draft.pin.length > 0 && !proofReady(draft) && (
            <Notice tone="warning" text={t('proof.pinInvalid')} />
          )}
        </>
      ) : (
        <CameraCapture
          photo={draft.photo}
          onCaptured={(photo) => onChange({ kind: 'photo', photo })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.xs, marginTop: space.sm },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  modes: { flexDirection: 'row', gap: space.sm },
  mode: { flex: 1 },
});
