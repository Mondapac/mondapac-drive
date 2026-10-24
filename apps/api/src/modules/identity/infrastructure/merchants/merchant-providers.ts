import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  MERCHANT_MEMBERSHIP_REPOSITORY,
  MERCHANT_REPOSITORY,
  type MerchantMembershipRepository,
  type MerchantRepository,
} from '../../application/ports/merchant.repository';
import {
  PrismaMerchantMembershipRepository,
  PrismaMerchantRepository,
} from './prisma-merchant.repository';

/** Binds the merchant and membership ports (only `infrastructure/` may reach `PrismaService`). */
export const merchantProviders: readonly FactoryProvider[] = [
  {
    provide: MERCHANT_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MerchantRepository => new PrismaMerchantRepository(prisma),
  },
  {
    provide: MERCHANT_MEMBERSHIP_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): MerchantMembershipRepository =>
      new PrismaMerchantMembershipRepository(prisma),
  },
];
