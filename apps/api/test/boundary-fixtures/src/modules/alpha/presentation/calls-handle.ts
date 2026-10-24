interface UseCaseLike {
  handle(): number;
}

// Violation: a controller reaches a use case through execute only, never handle.
export const violation = (useCase: UseCaseLike): number => useCase.handle();
