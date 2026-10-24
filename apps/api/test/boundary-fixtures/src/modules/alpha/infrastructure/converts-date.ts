// Allowed: a repository converts an instant to the Date that Prisma carries.
export function toColumn(epochMilliseconds: number): Date {
  return new Date(epochMilliseconds);
}
