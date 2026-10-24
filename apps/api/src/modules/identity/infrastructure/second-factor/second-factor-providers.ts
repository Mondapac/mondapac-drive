import type { FactoryProvider } from '@nestjs/common';
import type { AppConfig } from '../../../../platform/config/app-config';
import { APP_CONFIG } from '../../../../platform/config/config.module';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  CHALLENGE_TOKENS,
  ENROLMENT_SECRET_TAGS,
  INVITATION_TOKENS,
  type EnrolmentSecretTags,
  type OpaqueTokens,
} from '../../application/ports/second-factor-tokens';
import { localThrottleSecret } from '../sessions/hmac-throttle-keys';
import {
  CHALLENGE_TOKEN_PREFIX,
  HmacEnrolmentSecretTags,
  INVITATION_TOKEN_PREFIX,
  RandomPrefixedTokens,
} from './second-factor-tokens';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../../platform/subject-keys/subject-key-service';
import {
  INVITATION_REPOSITORY,
  type InvitationRepository,
} from '../../application/ports/invitation.repository';
import {
  SECOND_FACTOR_SECRETS,
  type SecondFactorSecrets,
} from '../../application/ports/second-factor-secrets';
import {
  SECOND_FACTOR_REPOSITORY,
  type SecondFactorRepository,
} from '../../application/ports/second-factor.repository';
import {
  SIGN_IN_CHALLENGE_REPOSITORY,
  type SignInChallengeRepository,
} from '../../application/ports/sign-in-challenge.repository';
import { PrismaInvitationRepository } from '../invitations/prisma-invitation.repository';
import { PrismaSecondFactorRepository } from './prisma-second-factor.repository';
import { PrismaSignInChallengeRepository } from './prisma-sign-in-challenge.repository';
import { SubjectKeySecondFactorSecrets } from './subject-key-second-factor-secrets';

/**
 * Binds the stores and the secrets of slice 7 (identity design 3.4, 3.6, 6.3, 7; data design
 * 3.10): the second factor with its recovery codes, the sign-in challenges, the invitations, and
 * the TOTP and recovery-code secrets over the account's subject key.
 */
export const secondFactorProviders: readonly FactoryProvider[] = [
  {
    provide: SECOND_FACTOR_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SecondFactorRepository =>
      new PrismaSecondFactorRepository(prisma),
  },
  {
    provide: SIGN_IN_CHALLENGE_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): SignInChallengeRepository =>
      new PrismaSignInChallengeRepository(prisma),
  },
  {
    provide: INVITATION_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): InvitationRepository =>
      new PrismaInvitationRepository(prisma),
  },
  {
    provide: SECOND_FACTOR_SECRETS,
    inject: [SUBJECT_KEY_SERVICE],
    useFactory: (subjectKeys: SubjectKeyService): SecondFactorSecrets =>
      new SubjectKeySecondFactorSecrets(subjectKeys),
  },
  {
    // Slice 7b: the tokens of challenges and invitations, each with its own prefix.
    provide: CHALLENGE_TOKENS,
    useFactory: (): OpaqueTokens => new RandomPrefixedTokens(CHALLENGE_TOKEN_PREFIX),
  },
  {
    provide: INVITATION_TOKENS,
    useFactory: (): OpaqueTokens => new RandomPrefixedTokens(INVITATION_TOKEN_PREFIX),
  },
  {
    // The acceptance's secret tag, keyed from the stack secret of 6.8 under its own label
    // (identity design 3.4, HF6). The local stand-in of that secret refuses production (H4).
    provide: ENROLMENT_SECRET_TAGS,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): EnrolmentSecretTags =>
      new HmacEnrolmentSecretTags(localThrottleSecret(config)),
  },
];
