/**
 * The privacy notice's version. Change it whenever the notice (web/src/app/features/privacy) changes
 * in a way people should see: everyone is asked to read and accept it again on their next visit.
 */
export const PRIVACY_VERSION = "2026-10-23";
/** Kept in sync with api/src/lib/retention.ts; the notice quotes them. */
export const RETENTION = { archivedTeamDays: 90, deletedTeamDays: 7, backupDays: 35, logDays: 30, deliveryDays: 90 } as const;
