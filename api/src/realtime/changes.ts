// Maps a changed table item to the team and the part of the team page it affects.
// Used by the fan-out to tell browsers what to reload.

export type Collection =
  | "settings" | "handbook" | "players" | "events" | "refjobs" | "agenda" | "meals"
  | "family" | "payments" | "ledger" | "announcements" | "tasks" | "members" | "invites";

export function describeChange(pk: string, sk: string): { teamId: string; collection: Collection } | null {
  if (pk.startsWith("INVITE#") && sk.startsWith("TEAM#")) return { teamId: sk.slice(5), collection: "invites" };
  if (!pk.startsWith("TEAM#")) return null;
  const teamId = pk.slice(5);
  if (sk === "META#SETTINGS") return { teamId, collection: "settings" };
  if (sk === "META#HANDBOOK") return { teamId, collection: "handbook" };
  if (sk.startsWith("PLAYER#")) return { teamId, collection: "players" };
  if (sk.startsWith("EVENT#")) {
    const part = sk.split("#")[2];
    if (part === "REFJOBS") return { teamId, collection: "refjobs" };
    if (part === "AGENDA") return { teamId, collection: "agenda" };
    if (part === "MEAL") return { teamId, collection: "meals" };
    return { teamId, collection: "events" };
  }
  if (sk.startsWith("FAMILY#")) return { teamId, collection: "family" };
  if (sk.startsWith("PAYMENT#")) return { teamId, collection: "payments" };
  if (sk.startsWith("LEDGER#")) return { teamId, collection: "ledger" };
  if (sk.startsWith("ANN#")) return { teamId, collection: "announcements" };
  if (sk.startsWith("TASK#")) return { teamId, collection: "tasks" };
  if (sk.startsWith("MEMBER#")) return { teamId, collection: "members" };
  return null;
}
