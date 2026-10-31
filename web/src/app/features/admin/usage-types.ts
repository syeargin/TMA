/** What GET /admin/usage and /admin/health send (api/src/api/routes/usage.ts). */
export type TeamStatus = 'notStarted' | 'quiet' | 'steady' | 'busy';

export interface UsageReport {
  period: '7d' | '30d' | 'season';
  from: string; to: string; prevFrom: string; prevTo: string; days: number; today: string;
  club: string;
  clubs: { clubId: string; name: string }[];
  tiles: {
    active7: number; active7Family: number; active7Staff: number; members: number;
    teamsInUse: number; teams: number; joined: number; roster: number; answeredPct: number | null; needsLook: number;
  };
  weekly: { week: string; family: number; staff: number }[];
  /** Monday first; 8 three-hour slots from midnight, Eastern time. */
  heat: number[][];
  funnel: { roster: number; invited: number; joined: number; answeredOnce: number; active30: number };
  waitingInvites: { n: number; worst: { name: string; n: number } | null };
  sources: { id: string; label: string; n: number }[];
  devices: { id: 'phone' | 'tablet' | 'computer'; n: number }[];
  teams: {
    teamId: string; name: string; clubId: string; clubName: string; roster: number; joined: number; members: number;
    active7: number; answeredPct: number | null; lastSeen: string; status: TeamStatus; why: string; opens: number;
  }[];
  features: { label: string; teams: number; of: number; opens: number }[];
  actions: { id: string; label: string; n: number; prev: number }[];
}

export interface HealthReport {
  period: '24h' | '7d' | '30d';
  from: string; to: string;
  requests: { total: number; failed: number; failedPct: number | null };
  pages: { phoneP95: number | null; loads: number };
  mail: { sent: number; delivered: number; bounced: number; complained: number; deliveredPct: number | null };
  feeds: { failing: { teamId: string; name: string }[] };
  liveNow: number;
  /** Hourly ("2026-10-30T19"), or daily for 30 days ("2026-10-30"). */
  points: { at: string; n: number; err: number }[];
  errors: { area: string; where: 'server' | 'browser'; n: number; lastAt: string }[];
  slowest: { area: string; label: string; p95: number; loads: number }[];
  releases: { commit: string; at: string; errorsAfter: number }[];
}
