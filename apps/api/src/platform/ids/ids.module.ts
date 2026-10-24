import { Global, Module } from '@nestjs/common';
import { UuidV7IdGenerator } from './uuid-v7-id-generator';

/** Injection token for the kernel's `IdGenerator`: the only source of new ids. */
export const ID_GENERATOR = Symbol('ID_GENERATOR');

/** Binds the UUIDv7 generator (it injects `CLOCK`). Global; exports the token only. */
@Global()
@Module({
  providers: [{ provide: ID_GENERATOR, useClass: UuidV7IdGenerator }],
  exports: [ID_GENERATOR],
})
export class IdsModule {}
