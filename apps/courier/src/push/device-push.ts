import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { pushDevice } from '../api/schemas';
import { t } from '../i18n';
import { offerIdOf, type PushService } from './push-service';

// An offer that arrives while the app is open still alerts the courier, who may be on another
// screen; the offer card itself comes from the API.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

/** Offers expire in seconds, so Android gets them on a high-importance channel. */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: t('push.channel'),
    importance: Notifications.AndroidImportance.HIGH,
  });
}

/** Expo's push service; the token is Expo's (`ExponentPushToken[…]`), never the raw device one. */
export const devicePush: PushService = {
  async deviceToken() {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
    try {
      await ensureChannel();
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) {
        permission = await Notifications.requestPermissionsAsync();
      }
      if (!permission.granted) return null;
      // The project id comes from the EAS config (Constants); a simulator has no token.
      const { data } = await Notifications.getExpoPushTokenAsync();
      const parsed = pushDevice.safeParse({ token: data, platform: Platform.OS });
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  onOffer(listener) {
    const handle = (notification: Notifications.Notification) => {
      const offerId = offerIdOf(notification.request.content.data);
      if (offerId) listener(offerId);
    };
    const received = Notifications.addNotificationReceivedListener(handle);
    const tapped = Notifications.addNotificationResponseReceivedListener((response) =>
      handle(response.notification),
    );
    // A tap that opened the app from the background or from closed.
    const last = Notifications.getLastNotificationResponse();
    if (last) handle(last.notification);
    return () => {
      received.remove();
      tapped.remove();
    };
  },
};
