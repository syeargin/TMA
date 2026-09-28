// One role table for the API and the site. Keep in sync with the hub's Access tab.
export const ROLES = ["admin", "coach", "coordinator", "food", "finance", "parent"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Team admin",
  coach: "Coach",
  coordinator: "Team coordinator",
  food: "Food coordinator",
  finance: "Finance",
  parent: "Parent / guardian"
};

const ALL: Role[] = [...ROLES];

export const PERMISSIONS = {
  contacts:   { label: "See roster phone numbers and emails", roles: ALL },
  fundView:   { label: "See the team fund and dues", roles: ALL },
  family:     { label: "Answer for own family: availability, travel, sizes, meals, payments", roles: ["parent"] },
  reimb:      { label: "Request a reimbursement", roles: ALL },
  attendance: { label: "Mark availability for any player", roles: ["admin", "coach", "coordinator"] },
  schedule:   { label: "Edit schedule, practices, tournaments, hotels, game-day sheets", roles: ["admin", "coach", "coordinator"] },
  refjobs:    { label: "Assign ref jobs", roles: ["admin", "coach", "coordinator"] },
  announce:   { label: "Post and pin announcements", roles: ["admin", "coach", "coordinator"] },
  handbook:   { label: "Edit the team handbook", roles: ["admin", "coach", "coordinator"] },
  meals:      { label: "Plan meals and assign families", roles: ["admin", "coordinator", "food"] },
  finance:    { label: "Add, edit and confirm fund entries", roles: ["admin", "coordinator", "finance"] },
  roster:     { label: "Edit the roster; fix any family's travel or sizes", roles: ["admin", "coordinator"] },
  tasks:      { label: "Manage coordinator tasks", roles: ["admin", "coordinator"] },
  settings:   { label: "Change team settings", roles: ["admin", "coordinator"] },
  accounts:   { label: "Invite people and set their roles", roles: ["admin"] }
} as const satisfies Record<string, { label: string; roles: readonly Role[] }>;

export type Permission = keyof typeof PERMISSIONS;

export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export function can(roles: Iterable<string>, perm: Permission): boolean {
  const allowed = PERMISSIONS[perm].roles as readonly string[];
  for (const r of roles) if (allowed.includes(r)) return true;
  return false;
}
