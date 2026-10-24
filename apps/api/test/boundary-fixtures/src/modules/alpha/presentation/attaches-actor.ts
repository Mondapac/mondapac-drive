import { attached } from '../../../platform/call-context/request-actor';

// Violation: only ActorGuard and the @Call() decorator file reach the request-to-actor map.
export const violation = attached;
