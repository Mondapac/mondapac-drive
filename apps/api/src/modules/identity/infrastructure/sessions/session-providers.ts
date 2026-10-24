import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../../platform/config/app-config';
import { APP_CONFIG } from '../../../../platform/config/config.module';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../application/ports/session.repository';
import {
  SESSION_TOKENS,
  THROTTLE_KEYS,
  type SessionTokens,
  type ThrottleKeys,
} from '../../application/ports/session-secrets';
import {
  SIGN_IN_RECORD_REPOSITORY,
  type SignInRecordRepository,
} from '../../application/ports/sign-in-record.repository';
import {
  THROTTLE_REPOSITORY,
  type ThrottleRepository,
} from '../../application/ports/throttle.repository';
import { HmacThrottleKeys, localThrottleSecret } from './hmac-throttle-keys';
import { PrismaSessionRepository } from './prisma-session.repository';
import { PrismaSignInRecordRepository } from './prisma-sign-in-record.repository';
import { PrismaThrottleRepository } from './prisma-throttle.repository';
import { RandomSessionTokens } from './random-session-tokens';

/**
 * Binds the session, throttle and sign-in-record ports of slice 2. They live in
 * `infrastructure/` because only this layer may reach `PrismaService` (dependency-cruiser
 * `persistence-internals-are-private`); the module file imports these providers.
 */
export const sessionProviders: readonly FactoryProvider[] = [
  {
    provide: SESSION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SessionRepository => new PrismaSessionRepository(prisma),
  },
  {
    provide: THROTTLE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ThrottleRepository => new PrismaThrottleRepository(prisma),
  },
  {
    provide: SIGN_IN_RECORD_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SignInRecordRepository =>
      new PrismaSignInRecordRepository(prisma),
  },
  {
    provide: SESSION_TOKENS,
    useFactory: (): SessionTokens => new RandomSessionTokens(),
  },
  {
    // The local stand-in of the throttle secret refuses production (H4; open until K1).
    provide: THROTTLE_KEYS,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): ThrottleKeys =>
      new HmacThrottleKeys(localThrottleSecret(config)),
  },
];
