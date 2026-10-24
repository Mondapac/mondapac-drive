import type { INestApplication } from '@nestjs/common';
import { ApiErrorFilter } from './platform/http/error.filter.js';

export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalFilters(new ApiErrorFilter());
  return app;
}
