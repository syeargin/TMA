import { Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { newId } from '../../core/dates';
import type { Handbook, Task, TaskStatus } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { Messages } from '../../shared/messages';
import { Sheet } from '../../shared/sheet';
import { SettingsForm } from './settings-form';

const STATUSES: TaskStatus[] = ['To do', 'In progress', 'Done', 'N/A'];
const TONE: Record<TaskStatus, string> = { 'To do': 'p-bad', 'In progress': 'p-warn', Done: 'p-ok', 'N/A': 'p-mute' };

/** Team handbook, who does what, and the coordinator's task list; team settings for admins and coordinators. */
@Component({
  selector: 'th-info',
  imports: [ReactiveFormsModule, RouterLink, Sheet, Messages, SettingsForm],
  templateUrl: './info.html'
})
export class Info {
  /** From the route: /info or /info/tasks */
  readonly section = input<string>('');
  readonly store = inject(TeamStore);
  /** "A5", or "the club" when the club has no short name. */
  readonly clubShort = computed(() => this.store.club()?.short || 'the club');
  private readonly fb = inject(NonNullableFormBuilder);
  readonly statuses = STATUSES;
  readonly tasksView = computed(() => this.section() === 'tasks');
  get editHandbook() { return this.store.can('handbook'); }
  get manageTasks() { return this.store.can('tasks'); }
  readonly settingsOpen = signal(false);

  /** Role holders by name, from the team's accounts. */
  readonly whoDoesWhat = computed(() => {
    const names = (role: string) => this.store.members().filter((m) => m.roles.includes(role as never)).map((m) => this.store.authorName(m.sub)).filter(Boolean);
    return [
      { label: 'Head coaches', people: (this.store.settings()?.coaches ?? []).map((c) => c.name + (c.phone ? ` · ${c.phone}` : '')) },
      { label: 'Team coordinator', people: names('coordinator') },
      { label: 'Food coordinators', people: names('food') },
      { label: 'Finance', people: names('finance') },
      { label: 'Team admin', people: names('admin') }
    ];
  });

  // ----- handbook -----
  readonly sectionIndex = signal<number | null>(null); // -1 = new
  readonly busy = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  readonly sectionForm = this.fb.group({ t: '', b: '' });

  editSection(i: number) {
    const s = i >= 0 ? this.store.handbook().sections[i] : { t: '', b: '' };
    this.sectionForm.reset({ t: s.t, b: s.b });
    this.error.set('');
    this.confirmDelete.set(false);
    this.sectionIndex.set(i);
  }

  async saveSection() {
    const v = this.sectionForm.getRawValue();
    if (!v.t.trim()) { this.error.set('Add a heading.'); return; }
    const i = this.sectionIndex()!;
    const sections = [...this.store.handbook().sections];
    const s = { t: v.t.trim(), b: v.b.trim() };
    if (i >= 0) sections[i] = s; else sections.push(s);
    await this.saveHandbook({ sections }, i >= 0 ? 'Handbook updated' : 'Section added');
  }

  async removeSection() {
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    const sections = this.store.handbook().sections.filter((_, k) => k !== this.sectionIndex());
    await this.saveHandbook({ sections }, 'Section removed');
  }

  move(i: number, by: -1 | 1) {
    const sections = [...this.store.handbook().sections];
    const j = i + by;
    if (j < 0 || j >= sections.length) return;
    [sections[i], sections[j]] = [sections[j], sections[i]];
    void this.store.saveHandbook({ sections }, 'Moved');
  }

  private async saveHandbook(h: Handbook, done: string) {
    this.busy.set(true);
    const ok = await this.store.saveHandbook(h, done);
    this.busy.set(false);
    if (ok) this.sectionIndex.set(null);
  }

  // ----- tasks -----
  readonly doneCount = computed(() => this.store.tasks().filter((t) => t.status === 'Done').length);
  tone(s?: TaskStatus) { return TONE[s ?? 'To do']; }
  readonly taskOpen = signal(false);
  readonly editingTask = signal<Task | null>(null);
  readonly taskForm = this.fb.group({ title: '', desc: '', owner: '', status: 'To do' as TaskStatus });

  openTask(t: Task | null) {
    this.editingTask.set(t);
    this.taskForm.reset({ title: t?.title ?? '', desc: t?.desc ?? '', owner: t?.owner ?? '', status: t?.status ?? 'To do' });
    this.error.set('');
    this.confirmDelete.set(false);
    this.taskOpen.set(true);
  }

  async saveTask() {
    const v = this.taskForm.getRawValue();
    if (!v.title.trim()) { this.error.set('Name the task.'); return; }
    const t = this.editingTask();
    const order = t?.order ?? Math.max(0, ...this.store.tasks().map((x) => x.order ?? 0)) + 1;
    const task: Task = { kid: t?.kid ?? newId('k'), title: v.title.trim(), desc: v.desc.trim() || undefined, owner: v.owner.trim() || undefined, status: v.status, order };
    this.busy.set(true);
    const ok = await this.store.saveTask(task, t ? 'Task saved' : 'Task added');
    this.busy.set(false);
    if (ok) this.taskOpen.set(false);
  }

  async removeTask() {
    const t = this.editingTask();
    if (!t) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    this.busy.set(true);
    const ok = await this.store.deleteTask(t.kid);
    this.busy.set(false);
    if (ok) this.taskOpen.set(false);
  }

  /** Tap the status to move it along: To do → In progress → Done → N/A → To do. */
  cycle(t: Task) {
    const next = STATUSES[(STATUSES.indexOf(t.status ?? 'To do') + 1) % STATUSES.length];
    void this.store.saveTask({ ...t, status: next }, `${t.title}: ${next}`);
  }
}
