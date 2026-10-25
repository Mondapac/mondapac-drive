import type {
  CourierProfile,
  DocumentRequirement,
  OnboardingRules,
  ProfileDocument,
  ProfileVehicle,
} from '../../api/schemas';

// Where a new courier is in onboarding, derived from the server's answers only: the app keeps no
// progress of its own, so it resumes at the right step after a restart, a lost connection or a
// sign-in on another phone. Framework-free; time comes from the caller's Clock.

/** One document the courier owes: a requirement of the Market, for one vehicle when per vehicle. */
export interface DocumentSlot {
  readonly requirement: DocumentRequirement;
  readonly vehicle?: ProfileVehicle;
}

export type SlotState = 'missing' | 'submitted' | 'verified' | 'rejected' | 'revoked' | 'expired';

export interface SlotStatus extends DocumentSlot {
  readonly state: SlotState;
  /** The document the state comes from; absent when nothing was submitted. */
  readonly document?: ProfileDocument;
}

export type OnboardingStep =
  | { readonly kind: 'profile' }
  | { readonly kind: 'vehicle' }
  | { readonly kind: 'documents'; readonly slots: readonly SlotStatus[] }
  | { readonly kind: 'waiting'; readonly slots: readonly SlotStatus[] }
  | { readonly kind: 'ready' }
  | { readonly kind: 'blocked'; readonly standing: 'suspended' | 'offboarded' };

/** The steps a new courier walks through, for the "step N of M" line. */
export const STEPS = ['profile', 'vehicle', 'documents', 'waiting'] as const;

/** States that still need an upload from the courier. */
const NEEDS_UPLOAD: ReadonlySet<SlotState> = new Set(['missing', 'rejected', 'revoked', 'expired']);

export function needsUpload(slot: SlotStatus): boolean {
  return NEEDS_UPLOAD.has(slot.state);
}

/** The documents the Market asks of this courier, given their work, cold chain and vehicles. */
export function documentSlots(
  profile: CourierProfile,
  rules: OnboardingRules,
): readonly DocumentSlot[] {
  const vehicles = profile.vehicles.filter((vehicle) => vehicle.active);
  const slots: DocumentSlot[] = [];
  for (const requirement of rules.documents) {
    if (
      requirement.employmentTypes &&
      !requirement.employmentTypes.includes(profile.employmentType)
    ) {
      continue;
    }
    if (requirement.coldChainOnly && !profile.coldChainCapable) continue;
    const forVehicle = (vehicle: ProfileVehicle) =>
      !requirement.vehicleTypes || requirement.vehicleTypes.includes(vehicle.type);
    if (requirement.perVehicle) {
      for (const vehicle of vehicles.filter(forVehicle)) slots.push({ requirement, vehicle });
    } else if (!requirement.vehicleTypes || vehicles.some(forVehicle)) {
      slots.push({ requirement });
    }
  }
  return slots;
}

/** What the courier's documents say about one slot at `nowMs`. */
export function slotStatus(slot: DocumentSlot, profile: CourierProfile, nowMs: number): SlotStatus {
  const candidates = profile.documents.filter(
    (document) =>
      document.type === slot.requirement.type &&
      (slot.vehicle ? document.vehicleId === slot.vehicle.id : true),
  );
  const current = (document: ProfileDocument) =>
    document.expiresAt === null || Date.parse(document.expiresAt) > nowMs;
  // A good document wins over an older refusal; among refusals the latest one explains.
  const verified = candidates.find(
    (document) => document.status === 'verified' && current(document),
  );
  if (verified) return { ...slot, state: 'verified', document: verified };
  const submitted = candidates.find(
    (document) => document.status === 'submitted' && current(document),
  );
  if (submitted) return { ...slot, state: 'submitted', document: submitted };
  const latest = candidates.at(-1);
  if (!latest) return { ...slot, state: 'missing' };
  if (latest.status === 'rejected' || latest.status === 'revoked') {
    return { ...slot, state: latest.status, document: latest };
  }
  return { ...slot, state: 'expired', document: latest };
}

/** The step to show; an active courier is ready (the home screen handles any later refusal). */
export function onboardingStep(
  profile: CourierProfile | null,
  rules: OnboardingRules,
  nowMs: number,
): OnboardingStep {
  if (!profile) return { kind: 'profile' };
  if (profile.status === 'suspended' || profile.status === 'offboarded') {
    return { kind: 'blocked', standing: profile.status };
  }
  if (profile.status === 'active') return { kind: 'ready' };
  if (!profile.vehicles.some((vehicle) => vehicle.active)) return { kind: 'vehicle' };
  const slots = documentSlots(profile, rules).map((slot) => slotStatus(slot, profile, nowMs));
  return slots.some(needsUpload) ? { kind: 'documents', slots } : { kind: 'waiting', slots };
}

/** The ISO date the courier typed (YYYY-MM-DD), as the instant fleet stores, or why not. */
export function expiryInstant(
  text: string,
  nowMs: number,
): { ok: true; value: string } | { ok: false; reason: 'invalid' | 'past' } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return { ok: false, reason: 'invalid' };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) {
    return { ok: false, reason: 'invalid' };
  }
  // The document is good through the day it names.
  const end = ms + 24 * 60 * 60 * 1000 - 1000;
  if (end <= nowMs) return { ok: false, reason: 'past' };
  return { ok: true, value: new Date(end).toISOString().replace('.000Z', 'Z') };
}

/** A Market code such as `greater-brisbane` or `driver_licence` as words, when no copy names it. */
export function humanise(code: string): string {
  const words = code.split(/[-_]/).filter(Boolean);
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}
