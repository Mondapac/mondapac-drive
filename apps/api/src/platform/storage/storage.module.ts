import { Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { DiskObjectStore, UnconfiguredObjectStore } from './disk-object-store';
import { OBJECT_STORE, type ObjectStore } from './object-store';

/** Chooses the adapter from the configuration. */
export function objectStoreFor(config: AppConfig): ObjectStore {
  return config.objectStoreDir === null
    ? new UnconfiguredObjectStore()
    : new DiskObjectStore(config.objectStoreDir);
}

/** Global: exports the port's token only. */
@Global()
@Module({
  providers: [{ provide: OBJECT_STORE, inject: [APP_CONFIG], useFactory: objectStoreFor }],
  exports: [OBJECT_STORE],
})
export class StorageModule {}
