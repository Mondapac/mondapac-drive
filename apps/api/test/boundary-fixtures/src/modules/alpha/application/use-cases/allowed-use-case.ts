// Allowed: a use case implements handle, calls it on this only, and may use a method named
// execute on an object it holds (the call is not a declaration).
export class AllowedUseCase {
  private readonly steps = { execute: (): number => 1 };

  protected handle(): number {
    return this.handle2() + this.steps.execute();
  }

  private handle2(): number {
    return 2;
  }

  retry(): number {
    return this.handle();
  }
}
