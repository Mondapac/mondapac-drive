// The `/testing` entry of the miniature kernel: fakes for tests only.
export class FixedClock {
  now(): number {
    return 0;
  }
}
