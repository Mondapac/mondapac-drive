import type * as ReactModule from 'react';
import type * as ReactNative from 'react-native';

// Native modules have no implementation under Jest; each is replaced by a small fake.

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    __store: store,
  };
});

jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  ActivityType: { OtherNavigation: 5 },
  getForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(() => Promise.resolve(false)),
  startLocationUpdatesAsync: jest.fn(() => Promise.resolve()),
  stopLocationUpdatesAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));

jest.mock('expo-image-manipulator', () => {
  const context: { resize: jest.Mock; renderAsync: jest.Mock } = {
    resize: jest.fn((): unknown => context),
    renderAsync: jest.fn(() =>
      Promise.resolve({
        saveAsync: jest.fn(() => Promise.resolve({ uri: 'file:///compressed.jpg', width: 1280 })),
      }),
    ),
  };
  return {
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: { manipulate: jest.fn(() => context) },
  };
});

jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNative>('react-native');
  const takePictureAsync = jest.fn(() =>
    Promise.resolve({ uri: 'file:///camera.jpg', width: 4032, height: 3024 }),
  );
  const CameraView = React.forwardRef((_props: object, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ takePictureAsync }));
    return React.createElement(View, { testID: 'camera' });
  });
  return {
    __takePictureAsync: takePictureAsync,
    CameraView,
    useCameraPermissions: () => [
      { granted: true, canAskAgain: true, status: 'granted' },
      jest.fn(() => Promise.resolve({ granted: true })),
    ],
  };
});
