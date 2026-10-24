// Violation: an inline directive does not switch a boundary rule off in the API sources
// (noInlineConfig); the clock read is still reported.
// eslint-disable-next-line no-restricted-syntax
export const now = new Date();
