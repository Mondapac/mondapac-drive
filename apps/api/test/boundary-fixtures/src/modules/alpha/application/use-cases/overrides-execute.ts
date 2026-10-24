// Violations: a use case implements handle and never overrides execute, whatever the form:
// method, computed key and property.
export class OverridesExecute {
  async execute(): Promise<number> {
    return Promise.resolve(1);
  }

  async ['execute'](): Promise<number> {
    return Promise.resolve(2);
  }

  readonly execute2 = 1;
}

export class OverridesExecuteByProperty {
  execute = (): number => 3;
}
