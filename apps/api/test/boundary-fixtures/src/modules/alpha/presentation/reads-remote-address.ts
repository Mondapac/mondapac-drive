// Violation: a controller reads the resolved client address, never the socket (ADR-0037).
declare const request: { socket: { remoteAddress?: string } };

export const origin = request.socket.remoteAddress;
