// Not looked at: application/ cannot import Prisma at all (dependency-cruiser rules), so the
// ownership check reads infrastructure/ and platform/persistence/ only.
declare const anything: Record<string, unknown>;

export const value = anything.betaOutbox;
