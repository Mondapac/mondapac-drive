import { Global, Module } from '@nestjs/common';
import { SystemClock } from './system-clock';

/** Injection token for the kernel's `Clock`: the only source of the current time. */
export const CLOCK = Symbol('CLOCK');

/** Binds the system clock. Global, like the other platform runtime modules; exports the token only. */
@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
