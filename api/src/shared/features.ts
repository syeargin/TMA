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
