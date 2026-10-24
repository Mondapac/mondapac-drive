import { ModelGateway } from '../../../platform/ai/model-gateway';
import type { ModelRequest } from '../../../platform/ai/model-provider';

// Violation (model-entry-only-from-the-allow-list): only the files on the checked-in allow-list
// reach the model entry point (ADR-0019 R2, R7). The port's types are allowed.
export const violation = ModelGateway;
export type Allowed = ModelRequest;
