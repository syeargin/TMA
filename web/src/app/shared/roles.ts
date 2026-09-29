import { FormControl, FormGroup } from '@angular/forms';
import { ROLES, ROLE_LABELS, type Role } from '@shared/permissions';

export type RoleChecks = FormGroup<Record<Role, FormControl<boolean>>>;

/** One checkbox per role, ticked for the ones given. */
export function roleChecks(selected: readonly string[] = []): RoleChecks {
  const controls = Object.fromEntries(ROLES.map((r) => [r, new FormControl(selected.includes(r), { nonNullable: true })])) as Record<Role, FormControl<boolean>>;
  return new FormGroup(controls);
}

export const pickedRoles = (group: RoleChecks): Role[] => ROLES.filter((r) => group.controls[r].value);
export const roleLabel = (r: string) => ROLE_LABELS[r as Role] ?? r;
export const roleList = (roles: readonly string[] = []) => roles.map(roleLabel).join(', ');
