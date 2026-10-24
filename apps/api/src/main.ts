import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { repositoryRoot } from './platform/platform.module.js';

async function bootstrap(): Promise<void> {
  try {
    process.loadEnvFile(join(repositoryRoot(), '.env'));
  } catch {
    // No .env file: use the real environment.
  }
  const app = configureApp(await NestFactory.create(AppModule));
  await app.listen(Number(process.env.PORT ?? 3100));
}

void bootstrap();
