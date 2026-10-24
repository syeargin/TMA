import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PRIVACY_VERSION, RETENTION, SUPPORT_EMAIL } from '@shared/privacy';

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

      <p>Teem Hub is where youth sports teams keep their schedule, roster, travel and team fund. It's operated by <b>Teem Hub Inc.</b>; your club and its team volunteers run their teams in it. This page explains what it keeps about you and your children, who can see it, how long it's kept, and how to see or delete it.</p>

      <h3>What we keep</h3>
      <ul>
        <li><b>About you:</b> your name, email address, password (stored scrambled by our sign-in service), and your roles on each team.</li>
        <li><b>Practice attendance, when the team uses it:</b> for each practice, whether your player was present, late, excused or absent, with an optional note from the coach.</li>
        <li><b>About your family, entered by you or your team coordinator:</b> your player's name, jersey and shirt numbers, hometown, food allergies, uniform sizes, availability for practices and events, travel plans for tournaments, meal sign-ups, and parents' names, phone numbers and emails.</li>
        <li><b>Money:</b> dues and reimbursements recorded in the team fund. Teem Hub never takes payments or card numbers; families pay the way the coordinator asks.</li>
        <li><b>Records kept automatically:</b> which account did what and when, and server logs of requests (including your internet address) for {{ r.logDays }} days.</li>
        <li><b>Emails we send you:</b> which email went to which address, when, whether it arrived or bounced, and whether it was opened, for {{ r.deliveryDays }} days. Team emails carry a small image that tells us when the email is first opened; mail apps that block images don't send it. Team admins and coordinators see whether their invites arrived, and on the team's Delivery health page, which addresses bounce and which families haven't opened team email for a month. They don't see who opened which email.</li>
        <li><b>Text alerts, if you turn them on:</b> your mobile number, when you agreed to texts and the exact words you agreed to, which alerts you get, and when you replied STOP or START. Records of texts sent are kept for {{ r.deliveryDays }} days, like emails.</li>
      </ul>
      <p>Children don't have accounts. Information about players is entered by their parents or the team's coordinators and coaches.</p>

      <h3>Who sees it</h3>
      <ul>
        <li><b>Everyone on your team</b> sees the schedule, announcements, the roster (players' names and numbers), who's coming to each practice or event, who's bringing team meals, members' names, and the team fund's totals.</li>
        <li><b>The mobile number for text alerts</b> is used only to send you the alerts you chose. Team staff don't see it, and it isn't added to the roster.</li>
        <li><b>Parents' phone numbers and emails</b> are seen by the coaches and team staff. Other families see them only if you choose to share them, using the checkbox on the Roster page. Sharing is off until you turn it on.</li>
        <li><b>Practice attendance</b> is seen by your family (your own player only), and by coaches, coordinators and team admins, who mark it. Other families never see it.</li>
        <li><b>Food allergies</b> are seen by your family, coaches, team admins and coordinators, and the food coordinator.</li>
        <li><b>Travel plans and uniform sizes</b> are seen by your family and the team coordinators and admins. Other families only see whether you've entered them.</li>
        <li><b>The full team fund</b>, including each family's dues, is seen by your family (your own lines), the finance volunteer, coordinators and admins. Everyone else sees the totals.</li>
        <li><b>Club admins and site owners</b> can open every team in their club to help run it. They have to use two-step sign-in to do so.</li>
        <li><b>Spreadsheet copies:</b> a team's admins, club admins and site owners can download the team's setup as a spreadsheet (the roster with parents' names, phone numbers, emails and players' food allergies, the staff and the schedule) to edit it and upload it again. Each download is recorded, and they're asked to keep the file private and delete it when they're done. Availability, travel plans, meal sign-ups and the team fund aren't in it.</li>
      </ul>
      <p>We don't sell your information, show ads, or use tracking or analytics tools. <b>Mobile numbers and agreement to text messages are never shared with third parties or affiliates for marketing or promotional purposes.</b></p>

      <h3>Services that handle it</h3>
      <ul>
        <li><b>Amazon Web Services</b> (in the United States) stores everything, signs you in, and sends Teem Hub's emails and text alerts. Mobile carriers deliver the texts.</li>
        <li><b>Only when you choose to use them:</b> "Add to calendar" sends that event's details to Google Calendar, Outlook or your calendar app, and map links open Apple Maps or Google Maps.</li>
      </ul>
      <p>Your browser keeps your sign-in on this device so you stay signed in. It's removed when you sign out.</p>

      <h3>How long it's kept</h3>
      <ul>
        <li>A team's information is kept while the team is active. When a season ends and the team is archived, it's kept read-only for <b>{{ r.archivedTeamDays }} days</b>, then deleted.</li>
        <li>When a site owner deletes a team, it's removed after <b>{{ r.deletedTeamDays }} days</b>, so a mistake can be undone.</li>
        <li>When you delete your account, it's removed right away.</li>
        <li>Backups are kept for up to {{ r.backupDays }} days for recovery, then expire on their own. Server logs are kept for {{ r.logDays }} days, and records of emails sent for {{ r.deliveryDays }} days.</li>
      </ul>

      <h3>Seeing, correcting and deleting your information</h3>
      <ul>
        <li><b>Download my data:</b> on your <a routerLink="/account">Account</a> page, get a file with everything kept about you and your family.</li>
        <li><b>Delete my account:</b> also on the Account page. It removes your sign-in, your team memberships, invites, and your own phone and email on your player's roster entry. Your player's record and the team's fund entries belong to the team; ask your team coordinator to remove or correct them.</li>
        <li><b>Questions, corrections and other requests</b> about a team go to your <b>team coordinator</b>. You'll find them under Contacts on your team's Home page. They can bring in the club or the site owner when needed.</li>
        <li><b>Anything else, or privacy questions for Teem Hub Inc.:</b> email <a [href]="'mailto:' + support">{{ support }}</a>.</li>
      </ul>

      <h3>Changes</h3>
      <p>When this notice changes in a way that matters, you'll be asked to read it again the next time you open Teem Hub.</p>

      <div class="links"><a class="link" routerLink="/terms">Terms of use</a><a class="link" routerLink="/">Back to Teem Hub</a></div>
    </article>`
})
export class Privacy {
  readonly version = PRIVACY_VERSION;
  readonly r = RETENTION;
  readonly support = SUPPORT_EMAIL;
}
