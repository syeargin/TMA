import { Component, ViewEncapsulation, computed, effect, inject, input, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FEATURES } from '@shared/features';
import { HELP_ROLES, HELP_ROLE_LABELS, type HelpRole } from '@shared/help';
import { AuthService } from '../../core/auth.service';
import { HeaderService } from '../../core/header.service';
import { HelpService, goLink, topicById, type HelpVia } from './help.service';
import { HelpText } from './help-text';

const VIAS: HelpVia[] = ['browse', 'search', 'popular', 'context', 'related', 'link'];

/** /help/:topic — one topic's steps, screenshot, tips and related topics. Works without signing in. */
@Component({
  selector: 'th-help-topic',
  imports: [RouterLink, HelpText],
  styleUrl: './help.css',
  encapsulation: ViewEncapsulation.None,
  template: `
  <main class="help">
    <nav class="help-crumbs small" aria-label="Breadcrumb">
      <a routerLink="/help" [queryParams]="back()">Help</a> ›
      @if (q()) { <a routerLink="/help" [queryParams]="back()">Results for “{{ q() }}”</a> › }
      <span aria-current="page">{{ topic()?.title ?? 'Not found' }}</span>
    </nav>
    @if (topic(); as t) {
      <article class="card help-article">
        <div class="card-b">
          <span class="pill p-mute">{{ labels[t.role] }}</span>
          <h2>{{ t.title }}</h2>
          <p class="lead">{{ t.summary }}</p>
          @if (t.feature) {
            <p class="hint">Only on teams that use <b>{{ features[t.feature].label }}</b>. A team admin or coordinator turns it on in Team settings.</p>
          }
          <div class="help-body">
            <ol class="help-steps">
              @for (s of t.steps; track $index) { <li><th-help-text [text]="s" /></li> }
            </ol>
            @if (t.shot) {
              <figure class="help-shot">
                <img [src]="'/help-img/' + t.shot.file" [alt]="t.shot.alt" loading="lazy" width="760" height="520">
                <figcaption class="small muted">{{ t.shot.alt }}. Sample team; yours will look like this with your own details.</figcaption>
              </figure>
            }
          </div>
          @if (t.tips?.length) {
            <div class="help-tips">
              <h3>Good to know</h3>
              <ul>@for (s of t.tips; track $index) { <li><th-help-text [text]="s" /></li> }</ul>
            </div>
          }
          @if (go(); as g) { <p><a class="btn primary" [routerLink]="g.url">{{ g.label }}</a></p> }
        </div>
      </article>
      @if (related().length) {
        <section class="card">
          <div class="card-h"><h3>Related</h3></div>
          <div class="card-b">
            <ul class="help-list">
              @for (r of related(); track r.id) {
                <li><a [routerLink]="['/help', r.id]" [queryParams]="{ via: 'related', team: team() || null, role: role() || null }"><b>{{ r.title }}</b><span class="small muted">{{ r.summary }}</span></a></li>
              }
            </ul>
          </div>
        </section>
      }
    } @else {
      <div class="empty">That help topic doesn't exist any more. <a routerLink="/help">See every topic</a></div>
    }
  </main>`
})
export class HelpTopic {
  readonly topicId = input.required<string>({ alias: 'topic' });
  readonly via = input<string>('');
  readonly team = input<string>('');
  readonly q = input<string>('');
  readonly role = input<string>('');
  private readonly help = inject(HelpService);
  private readonly auth = inject(AuthService);
  readonly labels = HELP_ROLE_LABELS;
  readonly features = FEATURES;
  readonly topic = computed(() => topicById(this.topicId()));
  readonly related = computed(() => (this.topic()?.related ?? []).map(topicById).filter((t) => !!t));
  readonly go = computed(() => { const t = this.topic(); return t ? goLink(t, this.team(), !!this.auth.user()) : null; });
  readonly back = computed(() => ({ q: this.q() || null, team: this.team() || null, role: this.role() || null }));

  constructor() {
    inject(HeaderService).reset();
    effect(() => {
      const t = this.topic();
      if (!t) return;
      const via = VIAS.find((v) => v === this.via()) ?? 'link';
      const r = this.role();
      const filter = (HELP_ROLES as readonly string[]).includes(r) ? r as HelpRole : 'all';
      untracked(() => {
        document.title = `${t.title} · Help · Teem Hub`;
        window.scrollTo?.(0, 0);
        // Wait for your teams (if signed in) so the view counts for your group.
        void this.help.loadMe().then(() => this.help.viewed(t.id, via, filter));
      });
    });
  }
}
