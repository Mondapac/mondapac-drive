// Allowed: the entry point reads appRole (P 12.2 rule 3).
declare const config: { appRole: string };

export const role = config.appRole;
