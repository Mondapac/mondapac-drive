import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  SUBJECT_KEY_SERVICE,
  type SubjectKeyService,
} from '../../../platform/subject-keys/subject-key-service';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepository,
} from '../application/ports/account.repository';
import { PrismaAccountRepository } from './prisma-account.repository';

/**
 * Binds {@link ACCOUNT_REPOSITORY}. It lives in `infrastructure/` because only this layer may
 * reach `PrismaService` and the SubjectKeyService (dependency-cruiser
 * `persistence-internals-are-private`, `subject-keys-only-in-infrastructure`); the
 * module file imports this provider, not the door.
 */
export const accountRepositoryProvider: FactoryProvider<AccountRepository> = {
  provide: ACCOUNT_REPOSITORY,
  inject: [PrismaService, SUBJECT_KEY_SERVICE],
  useFactory: (prisma: PrismaService, subjectKeys: SubjectKeyService) =>
    new PrismaAccountRepository(prisma, subjectKeys),
};
