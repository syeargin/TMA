import { Routes } from '@angular/router';
import { privacyGuard, signedInGuard, signedOutGuard } from './core/guards';
import { Forgot, Reset, SignIn, SignUp, Unconfigured, Verify } from './features/auth/auth-pages';
import { Home } from './features/home/home';
import { TeamHome } from './features/team/team-home';
import { Narrow } from './layout/narrow';
import { TeamShell } from './layout/team-shell';

const T = (s: string) => `${s} · Teem Hub`;

export const routes: Routes = [
  // Everyone lands here: families, staff and clubs thinking about Teem Hub.
  { path: '', pathMatch: 'full', title: "Teem Hub: your team's season in one place", loadComponent: () => import('./features/landing/landing').then((m) => m.Landing) },
  {
    path: 'teams/:teamId', component: TeamShell, canActivate: [signedInGuard, privacyGuard],
    children: [
      { path: '', component: TeamHome, title: T('Home') },
      { path: 'schedule', loadComponent: () => import('./features/schedule/schedule').then((m) => m.Schedule), title: T('Schedule') },
      { path: 'tournaments', loadComponent: () => import('./features/tournaments/tournaments').then((m) => m.Tournaments), title: T('Tournaments') },
      { path: 'tournaments/:eid', loadComponent: () => import('./features/tournaments/tournament').then((m) => m.Tournament), title: T('Tournament') },
      { path: 'tournaments/:eid/:section', loadComponent: () => import('./features/tournaments/tournament').then((m) => m.Tournament), title: T('Tournament') },
      { path: 'fund', loadComponent: () => import('./features/fund/fund').then((m) => m.Fund), title: T('Team fund') },
      { path: 'roster', loadComponent: () => import('./features/roster/roster').then((m) => m.Roster), title: T('Roster') },
      { path: 'roster/:section', loadComponent: () => import('./features/roster/roster').then((m) => m.Roster), title: T('Roster') },
      { path: 'info', loadComponent: () => import('./features/info/info').then((m) => m.Info), title: T('Team info') },
      { path: 'info/:section', loadComponent: () => import('./features/info/info').then((m) => m.Info), title: T('Coordinator tasks') },
      { path: 'members', loadComponent: () => import('./features/team/members').then((m) => m.Members), title: T('Members') },
      { path: 'communications', loadComponent: () => import('./features/team/communications').then((m) => m.Communications), title: T('Communications') }
    ]
  },
  {
    path: 'admin', canActivate: [signedInGuard, privacyGuard], title: T('Site admin'),
    loadComponent: () => import('./features/admin/site-admin').then((m) => m.SiteAdmin)
  },
  {
    path: 'clubs/:clubId', canActivate: [signedInGuard, privacyGuard], title: T('Club'),
    loadComponent: () => import('./features/club/club-admin').then((m) => m.ClubAdminPage)
  },
  // The help guide: open to everyone, signed in or not.
  { path: 'help', title: T('Help'), loadComponent: () => import('./features/help/help-home').then((m) => m.HelpHome) },
  { path: 'help/:topic', title: T('Help'), loadComponent: () => import('./features/help/help-topic').then((m) => m.HelpTopic) },
  {
    path: '', component: Narrow,
    children: [
      { path: 'teams', pathMatch: 'full', component: Home, canActivate: [signedInGuard, privacyGuard], title: T('Your teams') },
      { path: 'answer', title: T('Availability'), loadComponent: () => import('./features/account/answer').then((m) => m.Answer) },
      { path: 'unsubscribe', title: T('Unsubscribe'), loadComponent: () => import('./features/account/unsubscribe').then((m) => m.Unsubscribe) },
      { path: 'privacy', title: T('Privacy notice'), loadComponent: () => import('./features/privacy/privacy').then((m) => m.Privacy) },
      { path: 'terms', title: T('Terms of use'), loadComponent: () => import('./features/privacy/terms').then((m) => m.Terms) },
      { path: 'consent', canActivate: [signedInGuard], title: T('Privacy notice'), loadComponent: () => import('./features/account/consent').then((m) => m.Consent) },
      { path: 'account', canActivate: [signedInGuard], title: T('Your account'), loadComponent: () => import('./features/account/account').then((m) => m.Account) },
      { path: 'signin', component: SignIn, canActivate: [signedOutGuard], title: T('Sign in') },
      { path: 'signup', component: SignUp, canActivate: [signedOutGuard], title: T('Create your account') },
      { path: 'verify', component: Verify, canActivate: [signedOutGuard], title: T('Verify your email') },
      { path: 'forgot', component: Forgot, canActivate: [signedOutGuard], title: T('Reset your password') },
      { path: 'reset', component: Reset, canActivate: [signedOutGuard], title: T('Set a new password') },
      { path: 'security', canActivate: [signedInGuard], title: T('Two-step sign-in'), loadComponent: () => import('./features/account/two-step').then((m) => m.TwoStep) },
      { path: 'unconfigured', component: Unconfigured, title: T('Not set up') }
    ]
  },
  { path: '**', redirectTo: '' }
];
