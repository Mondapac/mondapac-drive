import { StyleSheet, Text, View } from 'react-native';
import { t } from '../../i18n';
import { Button } from '../../ui/Button';
import { makeStyles, radius, space, text } from '../../ui/theme';
import { documentLabel, reasonLabel, vehicleLabel } from './labels';
import { needsUpload, type SlotStatus } from './onboarding-steps';

interface Props {
  readonly slots: readonly SlotStatus[];
  /** Absent: the list only shows where each document stands. */
  readonly onUpload?: (slot: SlotStatus) => void;
}

function stateText(slot: SlotStatus): string {
  const reason = reasonLabel(slot.document?.rejectionReason ?? 'other');
  switch (slot.state) {
    case 'rejected':
      return t('onboarding.documents.state.rejected', { reason });
    case 'revoked':
      return t('onboarding.documents.state.revoked', { reason });
    default:
      return t(`onboarding.documents.state.${slot.state}`);
  }
}

/** Each document the Market asks of the courier, with where it stands. */
export function DocumentList({ slots, onUpload }: Props) {
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {slots.map((slot) => {
        const name = documentLabel(slot.requirement.type);
        const key = `${slot.requirement.type}:${slot.vehicle?.id ?? ''}`;
        return (
          <View key={key} style={styles.row}>
            <Text style={styles.name}>{name}</Text>
            {slot.vehicle && (
              <Text style={styles.detail}>
                {t('onboarding.documents.forVehicle', {
                  vehicle: slot.vehicle.plate ?? vehicleLabel(slot.vehicle.type),
                })}
              </Text>
            )}
            <Text
              style={[styles.detail, needsUpload(slot) && styles.attention]}
              accessibilityLabel={`${name}: ${stateText(slot)}`}
            >
              {stateText(slot)}
            </Text>
            {onUpload && needsUpload(slot) && (
              <Button
                label={`${t(slot.state === 'missing' ? 'onboarding.documents.add' : 'onboarding.documents.replace')}: ${name}`}
                onPress={() => onUpload(slot)}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    list: { gap: space.sm },
    row: { backgroundColor: c.surface, borderRadius: radius.lg, padding: space.md, gap: space.xs },
    name: { color: c.text, fontSize: text.label, fontWeight: '800' },
    detail: { color: c.muted, fontSize: text.body },
    attention: { color: c.warning, fontWeight: '700' },
  }),
);
