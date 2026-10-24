import { KEY_WRAPPER } from '../../../platform/subject-keys/key-wrapper';

// Violation (subject-keys-only-through-the-port): a module reaches the SubjectKeyService port
// and its labels only, never the wrapper, the store or the implementation (L3).
export const violation = KEY_WRAPPER;
