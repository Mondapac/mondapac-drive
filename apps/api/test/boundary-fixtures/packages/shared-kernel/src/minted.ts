const minted = new WeakSet<object>();

export function mint<T extends object>(fields: T): T {
  const value = Object.freeze({ ...fields });
  minted.add(value);
  return value;
}

export function isMinted(value: unknown): boolean {
  return typeof value === 'object' && value !== null && minted.has(value);
}
