import type { FactoryProvider } from '@nestjs/common';
import { LocaleCatalogues } from '../../../../platform/i18n/locale-catalogues';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  IDENTITY_MAIL_COMPOSER,
  type IdentityMailComposer,
} from '../../application/ports/identity-mails';
import {
  LINK_TARGETS,
  LINK_TOKENS,
  type LinkTargets,
  type LinkTokens,
} from '../../application/ports/link-secrets';
import {
  ONE_TIME_LINK_REPOSITORY,
  type OneTimeLinkRepository,
} from '../../application/ports/one-time-link.repository';
import { CatalogueMailComposer } from '../mail/mail-catalogue';
import { MarketConfigIdentityPolicy } from '../market-config-identity-policy';
import { PrismaOneTimeLinkRepository } from './prisma-one-time-link.repository';
import { RandomLinkTokens } from './random-link-tokens';

/**
 * Binds the one-time link and mail ports of slice 3 (identity design 3.7, 6.6, 9). The link
 * targets are read by the Market policy adapter, from the same `identity` section. The mail
 * composer checks at boot that every hosted Market's default locale has every mail text
 * in its `identity` catalogue (`config/locales/<locale>/identity.json`).
 */
export const linkProviders: readonly FactoryProvider[] = [
  {
    provide: ONE_TIME_LINK_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): OneTimeLinkRepository =>
      new PrismaOneTimeLinkRepository(prisma),
  },
  {
    provide: LINK_TOKENS,
    useFactory: (): LinkTokens => new RandomLinkTokens(),
  },
  {
    provide: LINK_TARGETS,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry): LinkTargets => new MarketConfigIdentityPolicy(markets),
  },
  {
    provide: IDENTITY_MAIL_COMPOSER,
    inject: [MarketRegistry, LocaleCatalogues],
    useFactory: (markets: MarketRegistry, catalogues: LocaleCatalogues): IdentityMailComposer =>
      new CatalogueMailComposer(markets, catalogues),
  },
];
