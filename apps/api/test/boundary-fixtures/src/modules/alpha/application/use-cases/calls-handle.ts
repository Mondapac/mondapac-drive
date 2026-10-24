class Other {
  handle(): number {
    return 1;
  }
}

const other = new Other();

// Violations: handle is called by UseCase.execute only, never on another object, whatever the
// form: call, computed member, .call and .bind.
export const violation = [
  new Other().handle(),
  other['handle'](),
  other.handle.call(other),
  other.handle.bind(other),
];
