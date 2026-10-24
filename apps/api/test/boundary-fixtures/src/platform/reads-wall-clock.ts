// In real code Temporal comes from the shared kernel; declared here so the file type-checks.
declare const Temporal: { Now: { instant(): object } };

// Violations: only platform/clock/ reads the wall clock.
export function violation(): [Date, string, number, object] {
  return [new Date(), Date(), Date.now(), Temporal.Now.instant()];
}
