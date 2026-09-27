// Key builders for the TeamHub single table (see db/key-design.md).
export const normEmail = (email: string) => email.trim().toLowerCase();

export const keys = {
  invite: (email: string, teamId: string) => ({ PK: `INVITE#${normEmail(email)}`, SK: `TEAM#${teamId}` }),
  invitePrefix: (email: string) => `INVITE#${normEmail(email)}`,
  member: (teamId: string, sub: string) => ({
    PK: `TEAM#${teamId}`, SK: `MEMBER#${sub}`,
    GSI1PK: `USER#${sub}`, GSI1SK: `TEAM#${teamId}`
  }),
  profile: (sub: string) => ({ PK: `USER#${sub}`, SK: "PROFILE" }),
  clubAdmin: (clubId: string, sub: string) => ({ PK: `CLUB#${clubId}`, SK: `ADMIN#${sub}` })
};

export const ROLES = ["admin", "coach", "coordinator", "food", "finance", "parent"] as const;
export type Role = (typeof ROLES)[number];

/** Comma-separated env list → normalized email set. */
export const emailSet = (csv: string | undefined) =>
  new Set((csv ?? "").split(",").map(normEmail).filter(Boolean));
