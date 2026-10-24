import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { CourierApi } from './api/client';
import type { CourierSession, CourierSettings, SignInInput } from './api/schemas';
import type { Clock } from './platform/clock/clock';
import {
  clearSession as clearStoredSession,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
} from './session/session-store';
import {
  locationAccess,
  startTracking,
  stopTracking,
  type LocationAccess,
} from './location/tracking';
import { setOnlineFlag } from './session/session-store';

/** Background location while online; tests pass a fake. */
export interface Tracking {
  access(): Promise<LocationAccess>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const deviceTracking: Tracking = {
  access: locationAccess,
  start: async () => {
    await setOnlineFlag(true);
    await startTracking();
  },
  // Updates stop first, so that nothing is sent once the courier is offline.
  stop: async () => {
    await stopTracking();
    await setOnlineFlag(false);
  },
};

interface AppServices {
  readonly api: CourierApi;
  readonly clock: Clock;
  readonly tracking: Tracking;
}

interface SessionState {
  readonly ready: boolean;
  readonly session: CourierSession | null;
  readonly signIn: (input: SignInInput) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

/** Where the session is kept; the default is the secure store, tests pass a fake. */
export interface SessionStorage {
  load(): Promise<CourierSession | null>;
  save(session: CourierSession): Promise<void>;
  clear(): Promise<void>;
}

const secureSessionStorage: SessionStorage = {
  load: loadStoredSession,
  save: saveStoredSession,
  clear: clearStoredSession,
};

const ServicesContext = createContext<AppServices | null>(null);
const SessionContext = createContext<SessionState | null>(null);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 5_000 },
      mutations: { retry: false },
    },
  });
}

interface Props {
  readonly api: CourierApi;
  readonly clock: Clock;
  readonly queryClient: QueryClient;
  readonly storage?: SessionStorage;
  readonly tracking?: Tracking;
  readonly children: ReactNode;
}

export function AppProviders({ api, clock, queryClient, storage, tracking, children }: Props) {
  const store = storage ?? secureSessionStorage;
  const location = tracking ?? deviceTracking;
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<CourierSession | null>(null);

  useEffect(() => {
    let active = true;
    void store
      .load()
      .catch(() => null)
      .then((loaded) => {
        if (!active) return;
        setSession(loaded);
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [store]);

  const signIn = useCallback(
    async (input: SignInInput) => {
      const created = await api.signIn(input);
      await store.save(created);
      setSession(created);
    },
    [api, store],
  );

  const signOut = useCallback(async () => {
    await location.stop().catch(() => undefined);
    await api.signOut().catch(() => undefined);
    await store.clear();
    queryClient.clear();
    setSession(null);
  }, [api, store, queryClient, location]);

  const services = useMemo(() => ({ api, clock, tracking: location }), [api, clock, location]);
  const sessionState = useMemo(
    () => ({ ready, session, signIn, signOut }),
    [ready, session, signIn, signOut],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ServicesContext.Provider value={services}>
        <SessionContext.Provider value={sessionState}>{children}</SessionContext.Provider>
      </ServicesContext.Provider>
    </QueryClientProvider>
  );
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices outside AppProviders');
  return services;
}

export function useSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside AppProviders');
  return session;
}

export const queryKeys = {
  settings: ['settings'] as const,
  status: ['status'] as const,
  offer: ['offer'] as const,
  job: (id: string) => ['job', id] as const,
  earnings: ['earnings'] as const,
};

/** The courier's Market settings (currency, cold-chain limits, support phone) from the API. */
export function useSettings(): CourierSettings | undefined {
  const { api } = useServices();
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.settings(),
    staleTime: 60 * 60 * 1000,
  }).data;
}
