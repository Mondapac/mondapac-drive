import { randomUUID } from 'node:crypto';

export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
