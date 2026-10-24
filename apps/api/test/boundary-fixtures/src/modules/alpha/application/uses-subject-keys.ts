import { SUBJECT_KEY_SERVICE } from '../../../platform/subject-keys/subject-key-service';

// Violation (subject-keys-only-in-infrastructure): encryption of a field is persistence work;
// only a module's infrastructure/ uses the SubjectKeyService (L3).
export const violation = SUBJECT_KEY_SERVICE;
