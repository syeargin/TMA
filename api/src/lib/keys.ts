// Key builders for the TeamHub single table (see db/key-design.md).
export const normEmail = (email: string) => email.trim().toLowerCase();

export const keys = {
  teamDir: (clubId: string, teamId: string) => ({ PK: `CLUB#${clubId}`, SK: `TEAM#${teamId}` }),
  clubAdmin: (clubId: string, sub: string) => ({ PK: `CLUB#${clubId}`, SK: `ADMIN#${sub}` }),
  settings: (t: string) => ({ PK: `TEAM#${t}`, SK: "META#SETTINGS" }),
  handbook: (t: string) => ({ PK: `TEAM#${t}`, SK: "META#HANDBOOK" }),
  player: (t: string, pid: string) => ({ PK: `TEAM#${t}`, SK: `PLAYER#${pid}` }),
  contacts: (t: string, pid: string) => ({ PK: `TEAM#${t}`, SK: `PLAYER#${pid}#CONTACTS` }),
  event: (t: string, eid: string) => ({ PK: `TEAM#${t}`, SK: `EVENT#${eid}` }),
  refjobs: (t: string, eid: string) => ({ PK: `TEAM#${t}`, SK: `EVENT#${eid}#REFJOBS` }),
  agenda: (t: string, eid: string) => ({ PK: `TEAM#${t}`, SK: `EVENT#${eid}#AGENDA` }),
  meal: (t: string, eid: string, mid: string) => ({ PK: `TEAM#${t}`, SK: `EVENT#${eid}#MEAL#${mid}` }),
  family: (t: string, pid: string) => ({ PK: `TEAM#${t}`, SK: `FAMILY#${pid}` }),
  payment: (t: string, payId: string) => ({ PK: `TEAM#${t}`, SK: `PAYMENT#${payId}` }),
  ledger: (t: string, lid: string) => ({ PK: `TEAM#${t}`, SK: `LEDGER#${lid}` }),
  announcement: (t: string, aid: string) => ({ PK: `TEAM#${t}`, SK: `ANN#${aid}` }),
  task: (t: string, kid: string) => ({ PK: `TEAM#${t}`, SK: `TASK#${kid}` }),
  member: (t: string, sub: string) => ({ PK: `TEAM#${t}`, SK: `MEMBER#${sub}` }),
  memberGsi: (t: string, sub: string) => ({ GSI1PK: `USER#${sub}`, GSI1SK: `TEAM#${t}` }),
  invite: (email: string, t: string) => ({ PK: `INVITE#${normEmail(email)}`, SK: `TEAM#${t}` }),
  inviteGsi: (email: string, t: string) => ({ GSI1PK: `TEAM#${t}`, GSI1SK: `INVITE#${normEmail(email)}` }),
  invitePrefix: (email: string) => `INVITE#${normEmail(email)}`,
  profile: (sub: string) => ({ PK: `USER#${sub}`, SK: "PROFILE" })
};

export { ROLES, type Role } from "../shared/permissions.js";

/** Comma-separated env list → normalized email set. */
export const emailSet = (csv: string | undefined) =>
  new Set((csv ?? "").split(",").map(normEmail).filter(Boolean));
