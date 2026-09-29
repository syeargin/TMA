// Live updates over the Team Hub WebSocket. Framework-free, so it can be unit tested with a fake socket.
//
// The socket only carries short "something changed" notices ({type:"changed", teamId, collections}).
// The page then re-reads through the REST API, so the API stays the single place that decides who
// may see what. If the socket drops, we reconnect with backoff and refetch once, since notices sent
// while we were away are lost.

export type LiveStatus = 'off' | 'connecting' | 'live' | 'reconnecting';

export interface LiveClientOptions {
  url: string;
  getToken: (force: boolean) => Promise<string | undefined>;
  onChange: (teamId: string, collections: string[]) => void;
  onStatus?: (status: LiveStatus) => void;
  onDenied?: (teamId: string, message: string) => void;
  /** For tests; defaults to the browser's WebSocket. */
  socketFactory?: (url: string) => WebSocket;
}

export const PING_MS = 5 * 60 * 1000; // API Gateway closes sockets idle for 10 minutes
export const COALESCE_MS = 300;       // one refresh for a burst of writes
export const MAX_BACKOFF_MS = 30_000;
const OPEN = 1;

interface ServerMessage { type?: string; teamId?: string | null; collections?: string[]; action?: string; code?: string; message?: string }

export class LiveClient {
  private ws: WebSocket | null = null;
  private teamId: string | null = null;  // the team we want to hear about; null = we want no socket
  private attempts = 0;
  private everSubscribed = false;        // after the first subscribe, a resubscribe means we may have missed notices
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<string>();
  private _status: LiveStatus = 'off';
  private readonly nudge = () => { if (this.teamId && !this.ws) { this.attempts = Math.min(this.attempts, 1); void this.open(); } };
  private readonly onVisible = () => { if (document.visibilityState === 'visible') this.nudge(); };

  constructor(private readonly opts: LiveClientOptions) {
    // Come back quickly when the laptop wakes or the network returns, instead of waiting out a backoff.
    if (typeof window !== 'undefined') window.addEventListener('online', this.nudge);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  get status(): LiveStatus { return this._status; }

  /** Follow one team. Reuses the open socket when switching teams. */
  watch(next: string): void {
    if (next === this.teamId && (this.ws || this.retryTimer)) return;
    const switching = this.teamId !== null && next !== this.teamId;
    this.teamId = next;
    this.everSubscribed = false;
    if (switching && this.ws?.readyState === OPEN) {
      this.setStatus('connecting');
      this.sendJson({ action: 'subscribe', teamId: next });
      return;
    }
    if (!this.ws) { this.attempts = 0; void this.open(); }
  }

  /** Close the socket (leaving the team page or signing out). */
  stop(): void {
    this.teamId = null;
    this.clearTimers();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = new Set();
    const sock = this.ws;
    this.ws = null;
    sock?.close(1000, 'done');
    this.setStatus('off');
  }

  dispose(): void {
    this.stop();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.nudge);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
  }

  private setStatus(s: LiveStatus) {
    if (s !== this._status) { this._status = s; this.opts.onStatus?.(s); }
  }

  private sendJson(msg: unknown) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(msg));
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = this.retryTimer = null;
  }

  private async open(): Promise<void> {
    this.clearTimers();
    if (!this.teamId || !this.opts.url) return;
    this.setStatus(this.attempts ? 'reconnecting' : 'connecting');
    let token: string | undefined;
    try { token = await this.opts.getToken(this.attempts >= 2); } catch { token = undefined; }
    if (!this.teamId) return; // stopped while we waited for the token
    if (!token) return this.scheduleRetry();
    const url = `${this.opts.url}?token=${encodeURIComponent(token)}`;
    const sock = this.opts.socketFactory ? this.opts.socketFactory(url) : new WebSocket(url);
    this.ws = sock;
    sock.onopen = () => {
      if (this.teamId) this.sendJson({ action: 'subscribe', teamId: this.teamId });
      this.pingTimer = setInterval(() => this.sendJson({ action: 'ping' }), PING_MS);
    };
    sock.onmessage = (ev: MessageEvent) => this.handle(sock, ev.data);
    sock.onclose = () => {
      if (this.ws !== sock) return; // an older socket we already replaced
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.teamId) this.scheduleRetry();
    };
    sock.onerror = () => { /* onclose follows and handles the retry */ };
  }

  private handle(sock: WebSocket, data: unknown) {
    let msg: ServerMessage;
    try { msg = JSON.parse(String(data)) as ServerMessage; } catch { return; }
    if (msg.type === 'subscribed' && msg.teamId === this.teamId) {
      const catchUp = this.everSubscribed;
      this.everSubscribed = true;
      this.attempts = 0;
      this.setStatus('live');
      if (catchUp) this.queue(['*']);
    } else if (msg.type === 'changed' && msg.teamId === this.teamId) {
      this.queue(msg.collections ?? ['*']);
    } else if (msg.type === 'error' && msg.code === 'reconnect') {
      sock.close(); // server forgot this socket; onclose reconnects
    } else if (msg.type === 'error' && msg.action === 'subscribe') {
      const denied = this.teamId;
      this.stop();
      if (denied) this.opts.onDenied?.(denied, msg.message || "You can't follow this team.");
    }
  }

  private scheduleRetry() {
    this.attempts += 1;
    this.setStatus('reconnecting');
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.attempts - 1));
    this.retryTimer = setTimeout(() => void this.open(), base / 2 + (Math.random() * base) / 2);
  }

  private queue(collections: string[]) {
    collections.forEach((c) => this.pending.add(c));
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      const list = [...this.pending];
      this.pending = new Set();
      if (this.teamId) this.opts.onChange(this.teamId, list);
    }, COALESCE_MS);
  }
}
