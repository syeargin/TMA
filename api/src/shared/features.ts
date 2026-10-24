// Optional team features, shared by the API and the site. Each team turns them on or off in its
// settings (Team Info → Team settings → Features). Everything is on unless the team turned it off, so
// teams made before this existed keep every feature.
import type { Role } from "./permissions.js";

export const FEATURES = {
  fund:      { label: "Team fund", help: "Dues, the fund ledger and reimbursement requests.", role: "finance" },
  meals:     { label: "Tournament meals", help: "Meal plans and families signing up for meals.", role: "food" },
  travel:    { label: "Travel and lodging", help: "Hotels, each family's travel plans and trip agendas for travel tournaments.", role: null },
  refjobs:   { label: "Ref jobs", help: "Work duties assigned at tournaments.", role: null },
  uniforms:  { label: "Uniform order", help: "Uniform items and each player's sizes.", role: null },
  tasks:     { label: "Coordinator tasks", help: "The coordinator's to-do list.", role: null },
  attendance: { label: "Practice attendance", help: "Coaches mark who came to each practice; families see their own player's attendance.", role: null },
  handbook:  { label: "Team handbook", help: "The kickoff-meeting sections and players' jobs in Team info. Who does what and the club's links stay.", role: null }
} as const satisfies Record<string, { label: string; help: string; role: Role | null }>;

export type Feature = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

/** Saved on the team settings as { fund: false, ... }: only switched-off features are stored. */
export type FeatureMap = Partial<Record<Feature, boolean>>;

export const isOn = (features: FeatureMap | null | undefined, f: Feature) => features?.[f] !== false;

/** Roles that only make sense with a feature on (Finance with the fund, Food with meals). */
export function roleFeature(role: string): Feature | null {
  for (const f of FEATURE_KEYS) if (FEATURES[f].role === role) return f;
  return null;
}

// ---------- What a club may use (site admin dashboard) ----------
// A site owner turns features on or off for a whole club. A team can only use a feature its club
// allows; within that, the team's own switches still apply. Email and text alerts are club-only:
// invites, sign-in codes and account notices always go, whatever is set here.

export const CLUB_ONLY = {
  email: { label: "Team emails", help: "Weekly emails, the staff digest, reminders, payment and announcement emails. Invites and account notices always go." },
  texts: { label: "Text alerts", help: "Text messages for last-minute changes, game days, duties and urgent posts." }
} as const;

export type ClubFeature = Feature | keyof typeof CLUB_ONLY;
export const CLUB_FEATURES: Record<ClubFeature, { label: string; help: string }> = { ...FEATURES, ...CLUB_ONLY };
export const CLUB_FEATURE_KEYS = Object.keys(CLUB_FEATURES) as ClubFeature[];

/** Saved on the club's controls as { texts: false, ... }: only switched-off features are stored. */
export type ClubFeatureMap = Partial<Record<ClubFeature, boolean>>;
export const clubAllows = (club: ClubFeatureMap | null | undefined, f: ClubFeature) => club?.[f] !== false;

/** The features a team can actually use: off if the team or its club switched them off. */
export function effectiveFeatures(team: FeatureMap | null | undefined, club: ClubFeatureMap | null | undefined): FeatureMap {
  const out: FeatureMap = { ...(team ?? {}) };
  for (const f of FEATURE_KEYS) if (!clubAllows(club, f)) out[f] = false;
  return out;
}
