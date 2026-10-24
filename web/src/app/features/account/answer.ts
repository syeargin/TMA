import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { Messages } from '../../shared/messages';
import { Page } from '../../shared/page';
import { tokenFromLink } from './unsubscribe';

type About = { teamId: string; teamName: string; player: string; title: string; date: string; time: string; answer: 'yes' | 'maybe' | 'no'; current: string; recorded: boolean };
const WORD: Record<string, string> = { yes: 'In', maybe: 'Maybe', no: 'Out' };

/**
 * /answer#t=… from an availability reminder's In / Maybe / Out buttons. Works without signing in. It
 * shows what it will record and waits for a tap, so link checkers that open every link in an email
 * can't answer for anyone.
 */
@Component({
  selector: 'th-answer',
  imports: [RouterLink, Messages],
  template: `
    <h2>Availability</h2>
    <th-messages [error]="error()" [notice]="notice()" />
    @if (!token) {
      <p>This link is missing its code. Open it again from the email, or answer on the team's schedule.</p>
    } @else if (about(); as a) {
      <p class="muted small">{{ a.teamName }}</p>
      <p style="font-size:18px;margin:6px 0 4px"><b>{{ a.date }} · {{ a.title }}</b></p>
      @if (a.time) { <p class="muted">{{ a.time }}</p> }
      @if (a.recorded) {
        <p class="answer-done" role="status">Recorded: {{ a.player || 'Your player' }} is <b>{{ word(a.answer) }}</b>.</p>
      } @else {
        @if (a.current) { <p class="small">Right now {{ a.player || 'your player' }} is marked <b>{{ word(a.current) }}</b>.</p> }
        <button class="btn primary" type="button" (click)="record()" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Mark ' + (a.player || 'them') + ' ' + word(a.answer) }}</button>
      }
      <p class="small muted" style="margin-top:14px">To change it, add a note, or answer for other dates, open the <a [routerLink]="['/teams', a.teamId, 'schedule']">team's schedule</a>.</p>
    } @else if (!error()) {
      <p class="muted">Loading…</p>
    }`
})
export class Answer extends Page {
  private readonly api = inject(ApiService);
  readonly token = tokenFromLink();
  readonly about = signal<About | null>(null);
  readonly word = (v: string) => WORD[v] ?? v;

  constructor() {
    super();
    if (this.token) void this.run(async () => this.about.set(await this.api.answerFromEmail(this.token, true)));
  }

  record() {
    return this.run(async () => this.about.set(await this.api.answerFromEmail(this.token, false)));
  }
}
