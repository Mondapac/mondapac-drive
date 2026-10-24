// Allowed: the resolver is the one reader of the socket's address (ADR-0037 decision 8).
declare const request: { socket: { remoteAddress?: string } };

export const socketAddress = request.socket.remoteAddress;
