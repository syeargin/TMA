import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PRIVACY_VERSION, RETENTION } from '@shared/privacy';

/**
 * /privacy — the privacy notice (R4). Plain language, readable without signing in.
 * When this changes in a way people should see, bump PRIVACY_VERSION in api/src/shared/privacy.ts:
 * everyone is asked to read and accept it again.
 */
@Component({
  selector: 'th-privacy',
  imports: [RouterLink],
  template: `
    <article class="notice">
      <h2>Privacy notice</h2>
      <p class="small muted">Version {{ version }}</p>

      <p>Team Hub is where youth sports teams keep their schedule, roster, travel and team fund. It's run by your club and its team volunteers. This page explains what it keeps about you and your children, who can see it, how long it's kept, and how to see or delete it.</p>

      <h3>What we keep</h3>
      <ul>
        <li><b>About you:</b> your name, email address, password (stored scrambled by our sign-in service), and your roles on each team.</li>
        <li><b>About your family, entered by you or your team coordinator:</b> your player's name, jersey and shirt numbers, hometown, food allergies, uniform sizes, availability for practices and events, travel plans for tournaments, meal sign-ups, and parents' names, phone numbers and emails.</li>
        <li><b>Money:</b> dues and reimbursements recorded in the team fund. Team Hub never takes payments or card numbers; families pay the way the coordinator asks.</li>
        <li><b>Records kept automatically:</b> which account did what and when, and server logs of requests (including your internet address) for {{ r.logDays }} days.</li>
      </ul>
      <p>Children don't have accounts. Information about players is entered by their parents or the team's coordinators and coaches.</p>

      <h3>Who sees it</h3>
      <ul>
        <li><b>Everyone on your team</b> sees the schedule, announcements, the roster (players' names and numbers), who's coming to each practice or event, who's bringing team meals, members' names, and the team fund's totals.</li>
        <li><b>Parents' phone numbers and emails</b> are seen by the coaches and team staff. Other families see them only if you choose to share them, using the checkbox on the Roster page. Sharing is off until you turn it on.</li>
        <li><b>Food allergies</b> are seen by your family, coaches, team admins and coordinators, and the food coordinator.</li>
        <li><b>Travel plans and uniform sizes</b> are seen by your family and the team coordinators and admins. Other families only see whether you've entered them.</li>
        <li><b>The full team fund</b>, including each family's dues, is seen by your family (your own lines), the finance volunteer, coordinators and admins. Everyone else sees the totals.</li>
        <li><b>Club admins and site owners</b> can open every team in their club to help run it. They have to use two-step sign-in to do so.</li>
      </ul>
      <p>We don't sell your information, show ads, or use tracking or analytics tools.</p>

      <h3>Services that handle it</h3>
      <ul>
        <li><b>Amazon Web Services</b> (in the United States) stores everything, signs you in, and sends sign-in codes by email.</li>
        <li><b>Google Fonts</b> supplies the lettering on these pages, so your browser asks Google for it.</li>
        <li><b>Only when you choose to use them:</b> "Add to calendar" sends that event's details to Google Calendar, Outlook or your calendar app, and map links open Apple Maps or Google Maps.</li>
      </ul>
      <p>Your browser keeps your sign-in on this device so you stay signed in. It's removed when you sign out.</p>

      <h3>How long it's kept</h3>
      <ul>
        <li>A team's information is kept while the team is active. When a season ends and the team is archived, it's kept read-only for <b>{{ r.archivedTeamDays }} days</b>, then deleted.</li>
        <li>When a site owner deletes a team, it's removed after <b>{{ r.deletedTeamDays }} days</b>, so a mistake can be undone.</li>
        <li>When you delete your account, it's removed right away.</li>
        <li>Backups are kept for up to {{ r.backupDays }} days for recovery, then expire on their own. Server logs are kept for {{ r.logDays }} days.</li>
      </ul>

      <h3>Seeing, correcting and deleting your information</h3>
      <ul>
        <li><b>Download my data:</b> on your <a routerLink="/account">Account</a> page, get a file with everything kept about you and your family.</li>
        <li><b>Delete my account:</b> also on the Account page. It removes your sign-in, your team memberships, invites, and your own phone and email on your player's roster entry. Your player's record and the team's fund entries belong to the team; ask your team coordinator to remove or correct them.</li>
        <li><b>Questions, corrections and other requests</b> go to your <b>team coordinator</b>. You'll find them under Contacts on your team's Home page. They can bring in the club or the site owner when needed.</li>
      </ul>

      <h3>Changes</h3>
      <p>When this notice changes in a way that matters, you'll be asked to read it again the next time you open Team Hub.</p>

      <div class="links"><a class="link" routerLink="/">Back to Team Hub</a></div>
    </article>`
})
export class Privacy {
  readonly version = PRIVACY_VERSION;
  readonly r = RETENTION;
}
