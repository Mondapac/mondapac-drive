// @ts-expect-error the SDK is not installed; the import is what the rule checks.
import Anthropic from '@anthropic-ai/sdk';

// Violation (model-provider-sdks-only-in-platform-ai): no provider SDK outside platform/ai (R7).
export const violation = Anthropic as unknown;
