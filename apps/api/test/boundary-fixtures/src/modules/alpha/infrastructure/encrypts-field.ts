import { fieldLabel } from '../../../platform/subject-keys/labels';
import { SUBJECT_KEY_SERVICE } from '../../../platform/subject-keys/subject-key-service';

// Allowed (L3): a repository in infrastructure/ uses the port and its labels.
export const allowed = [SUBJECT_KEY_SERVICE, fieldLabel('alpha.thing.secret')];
