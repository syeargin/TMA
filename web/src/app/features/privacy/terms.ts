import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SMS, SUPPORT_EMAIL, TERMS_VERSION } from '@shared/privacy';

/**
 * /terms — the terms of use, readable without signing in. The text-alerts section is what US carriers
 * check when they review the toll-free number (Messaging M4), so keep it in step with the opt-in on
 * the Account page and the HELP and STOP replies (api/src/shared/privacy.ts SMS).
 */
@Component({
  selector: 'th-terms',
  imports: [RouterLink],
  template: `
    <article class="notice">
      <h2>Terms of use</h2>
      <p class="small muted">Version {{ version }}</p>

      <p>Teem Hub is run by <b>Teem Hub Inc.</b> Clubs and their volunteers use it to run youth sports teams: the schedule, roster, travel, meals and team fund. By creating an account or using Teem Hub, you agree to these terms. Questions go to <a [href]="'mailto:' + support">{{ support }}</a>.</p>

      <h3>Your account</h3>
      <ul>
        <li>Accounts are for adults: parents and guardians, coaches and team volunteers. Players don't have accounts; their parents or team staff enter their details.</li>
        <li>Keep your sign-in to yourself, and use an email address you read. Club admins and site owners must use two-step sign-in.</li>
        <li>You can download your data or delete your account at any time from your <a routerLink="/account">Account</a> page.</li>
      </ul>

      <h3>Teams and what you enter</h3>
      <ul>
        <li>Each team is run by its club and the team's admins and coordinators. They decide who joins, what's on the schedule and how the team fund works, and they're responsible for what they post.</li>
        <li>Only enter information you're allowed to share, and keep it accurate. Use what you see about other families only for the team.</li>
        <li>Don't use Teem Hub to harass anyone, send spam, break the law, or try to get into accounts or teams that aren't yours.</li>
        <li>Teem Hub records dues and reimbursements but never takes payments. Families pay the way their team asks.</li>
      </ul>

      <h3>Emails</h3>
      <p>Teem Hub emails you sign-in codes, invites and notices about your account, which you can't turn off while you have an account. Your teams can also send schedule emails, reminders and announcements; turn any of them off from your Account page or the link at the bottom of each email.</p>

      <h3 id="text-alerts">Text alerts</h3>
      <p><b>{{ sms.program }}</b> are optional text messages about your teams: last-minute changes (a practice cancelled or moved), game-day reminders with arrival times and courts, your family's duties (line judge, scorebook, snacks), and urgent team announcements such as weather closures. They're never marketing.</p>
      <ul>
        <li><b>Signing up:</b> add your mobile number and tick the box agreeing to text alerts on your Account page. We text you once to confirm. Agreeing isn't a condition of using Teem Hub.</li>
        <li><b>How often:</b> {{ sms.frequency }}</li>
        <li><b>Message and data rates may apply</b>, according to your mobile plan.</li>
        <li><b>Stopping:</b> reply <b>STOP</b> to any text to stop all text alerts; we confirm with one last text. Reply <b>START</b> to turn them back on. You can also turn them off on your Account page.</li>
        <li><b>Help:</b> reply <b>HELP</b> for help, or email <a [href]="'mailto:' + support">{{ support }}</a>.</li>
        <li>Carriers aren't responsible for texts that are delayed or don't arrive. Text alerts are for mobile numbers in the United States.</li>
        <li>Your mobile number and your agreement to texts are never shared with third parties or affiliates for marketing. See the <a routerLink="/privacy">privacy notice</a> for how they're kept.</li>
      </ul>

      <h3>Availability and changes</h3>
      <ul>
        <li>We work to keep Teem Hub running and your information safe, but it's provided as it is, without guarantees that it will always be available or free of mistakes. Check important details, like a tournament's start time, with your team when it matters.</li>
        <li>To the extent the law allows, Teem Hub Inc. isn't liable for indirect losses from using Teem Hub, such as a missed event.</li>
        <li>We may change Teem Hub or these terms. When the terms change in a way that matters, we'll tell you in Teem Hub before the change applies.</li>
        <li>We may suspend an account or team that breaks these terms.</li>
      </ul>

      <div class="links"><a class="link" routerLink="/privacy">Privacy notice</a><a class="link" routerLink="/">Back to Teem Hub</a></div>
    </article>`
})
export class Terms {
  readonly version = TERMS_VERSION;
  readonly support = SUPPORT_EMAIL;
  readonly sms = SMS;
}
