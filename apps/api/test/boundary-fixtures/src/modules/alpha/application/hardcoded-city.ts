// Violation (no-market-or-vertical-literal): a service area is data of config/service-areas/,
// not a branch in a module.
export function violation(areaName: string): boolean {
  return areaName === 'Brisbane' || areaName === `BRISBANE`;
}
