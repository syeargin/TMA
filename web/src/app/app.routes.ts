import { Routes } from '@angular/router';
import { signedInGuard, signedOutGuard } from './core/guards';
import { Forgot, Reset, SignIn, SignUp, Unconfigured, Verify } from './features/auth/auth-pages';
import { Home } from './features/home/home';
import { Schedule } from './features/schedule/schedule';
import { Members } from './features/team/members';
import { TeamHome } from './features/team/team-home';
import { Narrow } from './layout/narrow';
import { TeamShell } from './layout/team-shell';

const T = (s: string) => `${s} · A5 Team Hub`;

export const routes: Routes = [
  {
    path: 'teams/:teamId', component: TeamShell, canActivate: [signedInGuard],
    children: [
      { path: '', component: TeamHome, title: T('Home') },
      { path: 'schedule', component: Schedule, title: T('Schedule') },
      { path: 'members', component: Members, title: T('Members') }
    ]
  },
  {
    path: '', component: Narrow,
    children: [
      { path: '', component: Home, canActivate: [signedInGuard], title: T('Your teams') },
      { path: 'signin', component: SignIn, canActivate: [signedOutGuard], title: T('Sign in') },
      { path: 'signup', component: SignUp, canActivate: [signedOutGuard], title: T('Create your account') },
      { path: 'verify', component: Verify, canActivate: [signedOutGuard], title: T('Verify your email') },
      { path: 'forgot', component: Forgot, canActivate: [signedOutGuard], title: T('Reset your password') },
      { path: 'reset', component: Reset, canActivate: [signedOutGuard], title: T('Set a new password') },
      { path: 'unconfigured', component: Unconfigured, title: T('Not set up') }
    ]
  },
  { path: '**', redirectTo: '' }
];
