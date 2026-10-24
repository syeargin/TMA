/**
 * The privacy notice's version. Change it whenever the notice (web/src/app/features/privacy) changes
 * in a way people should see: everyone is asked to read and accept it again on their next visit.
 */
export const PRIVACY_VERSION = "2026-10-24.2";
/** Kept in sync with api/src/lib/retention.ts; the notice quotes them. */
export const RETENTION = { archivedTeamDays: 90, deletedTeamDays: 7, backupDays: 35, logDays: 30, deliveryDays: 90 } as const;

/** The terms of use (web/src/app/features/privacy/terms.ts). */
export const TERMS_VERSION = "2026-10-24";
export const SUPPORT_EMAIL = "support@teemhub.net";

/**
 * Text alerts (Messaging M4). These words are what US carriers review when they approve the
 * toll-free number, so the opt-in, the terms, the registration form and the automatic replies all
 * read from here. Changing `consent` changes `consentVersion`: each person's consent record keeps
 * the exact words they agreed to.
 */
export const SMS = {
  program: "Teem Hub text alerts",
  frequency: "It depends on your teams' schedules: usually 1 to 5 texts a week during the season, and fewer outside it.",
  consentVersion: "2026-10-24",
  consent:
    "Text me Teem Hub alerts about my teams at this number: last-minute changes, game-day reminders, my family's duties and urgent announcements. " +
    "Usually 1 to 5 texts a week in season. Message and data rates may apply. Reply STOP to stop, HELP for help. Agreeing isn't required to use Teem Hub.",
  replies: {
    confirm: "Teem Hub: text alerts are on for your teams. Usually 1-5 msgs/wk. Msg & data rates may apply. Reply HELP for help, STOP to stop.",
    help: "Teem Hub alerts: team changes, game-day and duty reminders. Usually 1-5 msgs/wk. Msg & data rates may apply. Help: support@teemhub.net. Reply STOP to stop.",
    stop: "Teem Hub: you're unsubscribed and won't get more texts. Reply START to turn alerts back on.",
    start: "Teem Hub: text alerts are back on. Msg & data rates may apply. Reply HELP for help, STOP to stop."
  }
} as const;
