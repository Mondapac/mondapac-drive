import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ConcurrentModificationError } from '../../modules/delivery/application/ports.js';
import { DeliveryDomainError } from '../../modules/delivery/domain/errors.js';

const NOT_FOUND = new Set(['delivery.not-found', 'market.not-hosted']);

/** Maps errors to a stable JSON body: { code, message, issues? }. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({ code: 'request.invalid', message: 'The request is invalid', issues: error.issues });
    } else if (error instanceof DeliveryDomainError) {
      res
        .status(NOT_FOUND.has(error.code) ? 404 : 422)
        .json({ code: error.code, message: error.message });
    } else if (error instanceof ConcurrentModificationError) {
      res.status(409).json({ code: 'delivery.conflict', message: error.message });
    } else if (error instanceof RangeError) {
      res.status(400).json({ code: 'request.invalid', message: error.message });
    } else if (error instanceof HttpException) {
      res.status(error.getStatus()).json({ code: 'http.error', message: error.message });
    } else {
      res.status(500).json({ code: 'internal', message: 'Something went wrong' });
    }
  }
}
