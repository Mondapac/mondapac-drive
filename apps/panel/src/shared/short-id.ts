/** The end of an id, in capitals, as a short reference in a list ("654165CC"). */
export function shortId(id: string): string {
  return id.slice(-8).toUpperCase();
}
