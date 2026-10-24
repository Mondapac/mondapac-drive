// Allowed: platform/worker/ reads appRole (P 12.2 rule 3).
declare const config: { appRole: string };

export const isWorker = config.appRole === 'worker';
