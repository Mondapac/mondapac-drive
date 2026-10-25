import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  I18nManager,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { t } from '../i18n';
import { makeStyles, radius, text, useTheme } from './theme';

const KNOB = 48;
const INSET = 4;
/** How far along the track the knob must be let go to confirm. */
const THRESHOLD = 0.8;

interface Props {
  readonly label: string;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}

/**
 * A step that cannot be taken back (accept, arrived, picked up) is confirmed by sliding the knob
 * across, so that a tap in a moving car does not record it. A screen reader confirms it with its
 * activate action (double tap).
 */
export function SlideToConfirm({ label, onConfirm, disabled, busy }: Props) {
  const styles = useStyles();
  const palette = useTheme();
  const inactive = disabled === true || busy === true;
  const [track, setTrack] = useState(0);
  const offset = useRef(new Animated.Value(0)).current;
  const latest = useRef({ track, inactive, onConfirm });
  latest.current = { track, inactive, onConfirm };
  // The knob travels towards the end of the line: right, or left in a right-to-left language.
  const sign = I18nManager.isRTL ? -1 : 1;

  const travel = () => Math.max(latest.current.track - KNOB - INSET * 2, 1);
  const reset = () =>
    Animated.spring(offset, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.inactive,
      onMoveShouldSetPanResponder: (_, g) => !latest.current.inactive && Math.abs(g.dx) > 4,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        offset.setValue(Math.min(Math.max(g.dx * sign, 0), travel()));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx * sign >= travel() * THRESHOLD) {
          Animated.timing(offset, {
            toValue: travel(),
            duration: 120,
            useNativeDriver: true,
          }).start(() => {
            latest.current.onConfirm();
            reset();
          });
        } else {
          reset();
        }
      },
      onPanResponderTerminate: reset,
    }),
  ).current;

  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'activate' && !inactive) onConfirm();
  };

  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('slide.hint')}
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      accessibilityActions={[{ name: 'activate', label }]}
      onAccessibilityAction={onAccessibilityAction}
      onLayout={(event) => setTrack(event.nativeEvent.layout.width)}
      style={[styles.track, inactive && styles.inactive]}
    >
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      <Animated.View
        {...responder.panHandlers}
        style={[styles.knob, { transform: [{ translateX: Animated.multiply(offset, sign) }] }]}
      >
        {busy ? (
          <ActivityIndicator color={palette.primary} />
        ) : (
          <Text style={styles.arrow}>{I18nManager.isRTL ? '←' : '→'}</Text>
        )}
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c) =>
  StyleSheet.create({
    track: {
      height: KNOB + INSET * 2,
      borderRadius: radius.pill,
      backgroundColor: c.primary,
      justifyContent: 'center',
      paddingStart: KNOB + INSET * 3,
      paddingEnd: KNOB / 2,
    },
    inactive: { opacity: 0.4 },
    label: { color: c.primaryText, fontSize: text.label, fontWeight: '800', textAlign: 'center' },
    knob: {
      position: 'absolute',
      start: INSET,
      top: INSET,
      width: KNOB,
      height: KNOB,
      borderRadius: KNOB / 2,
      backgroundColor: c.primaryText,
      alignItems: 'center',
      justifyContent: 'center',
    },
    arrow: { color: c.primary, fontSize: 22, fontWeight: '800' },
  }),
);
