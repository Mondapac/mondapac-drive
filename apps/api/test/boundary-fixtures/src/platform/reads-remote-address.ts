// Violation: only platform/http/client-address.ts reads the socket's address (ADR-0037
// decision 8): a member, a computed member and a destructured property.
declare const request: { socket: { remoteAddress?: string } };

export function violates(): unknown[] {
  const { remoteAddress } = request.socket;
  return [request.socket.remoteAddress, request.socket['remoteAddress'], remoteAddress];
}
