interface Handler {
  handle(): number;
}

// Violation since slice 2 (W8): the handle rule covers every file of a module, so a handler
// object in a module names its method something else.
export const run = (handler: Handler): number => handler.handle();
