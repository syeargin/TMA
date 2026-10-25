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
  // Parents see their own family's details, plus the contacts of families who chose to share them (R3).
  contacts:   { label: "See every family's phone numbers and emails", roles: ["admin", "coach", "coordinator", "food", "finance"] },
  allergies:  { label: "See every player's food allergies", roles: ["admin", "coach", "coordinator", "food"] },
  fundView:   { label: "See the team fund totals and own dues", roles: ALL },
  ledger:     { label: "See every fund entry and every family's dues", roles: ["admin", "coordinator", "finance"] },
  family:     { label: "Answer for own family: availability, travel, sizes, meals, payments", roles: ["parent"] },
  reimb:      { label: "Request a reimbursement", roles: ALL },
  attendance: { label: "Mark availability for any player", roles: ["admin", "coach", "coordinator"] },
  takeAttendance: { label: "Take practice attendance and see every player's", roles: ["admin", "coach", "coordinator"] },
  schedule:   { label: "Edit schedule, practices, tournaments, hotels, game-day sheets", roles: ["admin", "coach", "coordinator"] },
  refjobs:    { label: "Assign ref jobs", roles: ["admin", "coach", "coordinator"] },
  announce:   { label: "Post and pin announcements", roles: ["admin", "coach", "coordinator"] },
  handbook:   { label: "Edit the team handbook", roles: ["admin", "coach", "coordinator"] },
  meals:      { label: "Plan meals and assign families", roles: ["admin", "coordinator", "food"] },
  finance:    { label: "Add, edit and confirm fund entries", roles: ["admin", "coordinator", "finance"] },
  roster:     { label: "Edit the roster; see and fix any family's travel or sizes", roles: ["admin", "coordinator"] },
  tasks:      { label: "Manage coordinator tasks", roles: ["admin", "coordinator"] },
  calendarFeed: { label: "Connect the team's calendar feed and set its import rules", roles: ["admin", "coordinator"] },
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
