import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { CourierApi } from '../api/client';
import { onceEach, type PushService } from './push-service';

/**
 * Registers this device for offer pushes while the courier is on the home screen: on mount and
 * each time the app comes back to the foreground, because the server drops a courier's devices
 * when identity ends sessions, and re-registering is how a living session gets its device back.
 * `onOffer` runs once per offer id. `registered` tells the caller it may poll less often.
 */
export function useOfferPush(
  push: PushService,
  api: CourierApi,
  /** False until the session is loaded: the server registers the session's device. */
  signedIn: boolean,
  onOffer: (offerId: string) => void,
): { readonly registered: boolean } {
  const [registered, setRegistered] = useState(false);
  const latestOnOffer = useRef(onOffer);
  latestOnOffer.current = onOffer;

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    const register = async () => {
      const device = await push.deviceToken();
      const ok =
        device !== null &&
        (await api.registerPushDevice(device).then(
          () => true,
          () => false,
        ));
      if (active) setRegistered(ok);
    };
    void register();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void register();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [push, api, signedIn]);

  useEffect(() => {
    const first = onceEach();
    return push.onOffer((offerId) => {
      if (first(offerId)) latestOnOffer.current(offerId);
    });
  }, [push]);

  return { registered };
}
