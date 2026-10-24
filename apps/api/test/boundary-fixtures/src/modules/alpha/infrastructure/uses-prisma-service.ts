import { PrismaService } from '../../../platform/persistence/prisma.service';

// Allowed: infrastructure may use PrismaService.
export const allowed = new PrismaService();
