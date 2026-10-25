import type * as ReactModule from 'react';
import type * as ReactNative from 'react-native';

// Native modules have no implementation under Jest; each is replaced by a small fake.

/** The fake device's files (see the expo-file-system mock). */
function mockDeviceFiles(): Set<string> {
  return jest.requireMock<{ __files: Set<string> }>('expo-file-system').__files;
}

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

// The device speaks English unless a test switches the language (setLocaleForTesting).
jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageTag: 'en-AU', languageCode: 'en' }]),
}));

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
        saveAsync: jest.fn(() => {
          mockDeviceFiles().add('file:///compressed.jpg');
          return Promise.resolve({ uri: 'file:///compressed.jpg', width: 1280 });
        }),
      }),
    ),
  };
  return {
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: { manipulate: jest.fn(() => context) },
  };
});

// Files on the device: `__files` holds the URIs that exist, and a delete removes one.
jest.mock('expo-file-system', () => {
  const files = new Set<string>();
  const folders = new Set<string>();
  class File {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return files.has(this.uri);
    }
    delete() {
      if (!files.delete(this.uri)) throw new Error('file missing');
    }
  }
  class Directory {
    readonly uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists() {
      return folders.has(this.uri);
    }
    delete() {
      folders.delete(this.uri);
      for (const uri of files) if (uri.startsWith(`${this.uri}/`)) files.delete(uri);
    }
  }
  return {
    File,
    Directory,
    Paths: { cache: new Directory('file:///cache') },
    __files: files,
    __folders: folders,
  };
});

jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNative>('react-native');
  const takePictureAsync = jest.fn(() => {
    mockDeviceFiles().add('file:///camera.jpg');
    return Promise.resolve({ uri: 'file:///camera.jpg', width: 4032, height: 3024 });
  });
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

// Offer pushes: no permission and no token unless a test says otherwise (screens take a fake
// PushService; this only keeps the device adapter loadable).
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve(null)),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false, canAskAgain: false })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false, canAskAgain: false })),
  getExpoPushTokenAsync: jest.fn(() => Promise.reject(new Error('no push in tests'))),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}));

// React Native's Jest preset answers AppState listeners with nothing; the home screen removes
// its foreground listener on unmount.
beforeEach(() => {
  const { AppState } = jest.requireActual<typeof ReactNative>('react-native');
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }));
});

// The map is native: a plain view stands in, with each pin as a labelled view.
jest.mock('react-native-maps', () => {
  const React = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNative>('react-native');
  const MapView = React.forwardRef(
    (props: { children?: ReactModule.ReactNode }, ref: ReactModule.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({
        fitToCoordinates: jest.fn(),
        animateToRegion: jest.fn(),
      }));
      return React.createElement(View, { testID: 'live-map' }, props.children);
    },
  );
  const Marker = (props: { title?: string }) =>
    React.createElement(View, { testID: 'map-pin', accessibilityLabel: props.title });
  return {
    __esModule: true,
    default: MapView,
    Marker,
    PROVIDER_GOOGLE: 'google',
  };
});
