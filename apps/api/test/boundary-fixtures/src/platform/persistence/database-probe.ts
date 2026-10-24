import { PrismaService } from './prisma.service';

export class DatabaseProbe {
  readonly prisma = new PrismaService();
}
