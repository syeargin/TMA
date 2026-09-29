import { LiveClient, LiveStatus } from './live-client';

class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

describe('LiveClient', () => {
  let sockets: FakeSocket[];
  const last = () => sockets[sockets.length - 1];
  const make = (over: Partial<ConstructorParameters<typeof LiveClient>[0]> = {}) =>
    new LiveClient({
      url: 'wss://x/live',
      getToken: async () => 'tok',
      onChange: () => {},
      socketFactory: (u) => { const s = new FakeSocket(u); sockets.push(s); return s as unknown as WebSocket; },
      ...over
    });

  beforeEach(() => { sockets = []; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('subscribes, coalesces notices, catches up after a reconnect, switches teams, and stops when denied', async () => {
    const changes: [string, string[]][] = [];
    const statuses: LiveStatus[] = [];
    const denied: string[] = [];
    const live = make({ onChange: (t, c) => changes.push([t, [...c].sort()]), onStatus: (s) => statuses.push(s), onDenied: (t) => denied.push(t) });

    live.watch('ta');
    await vi.advanceTimersByTimeAsync(0);
    const s1 = last();
    expect(s1.url).toBe('wss://x/live?token=tok');
    s1.open();
    expect(s1.sent[0]).toEqual({ action: 'subscribe', teamId: 'ta' });
    s1.recv({ type: 'subscribed', teamId: 'ta' });
    expect(live.status).toBe('live');
    expect(changes).toHaveLength(0);

    s1.recv({ type: 'changed', teamId: 'ta', collections: ['members'] });
    s1.recv({ type: 'changed', teamId: 'ta', collections: ['events', 'members'] });
    s1.recv({ type: 'changed', teamId: 'tb', collections: ['players'] });
    await vi.advanceTimersByTimeAsync(300);
    expect(changes).toEqual([['ta', ['events', 'members']]]);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(s1.sent.at(-1)).toEqual({ action: 'ping' });

    s1.drop();
    expect(live.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    const s2 = last();
    expect(s2).not.toBe(s1);
    s2.open();
    s2.recv({ type: 'subscribed', teamId: 'ta' });
    await vi.advanceTimersByTimeAsync(300);
    expect(changes.at(-1)).toEqual(['ta', ['*']]);

    s2.recv({ type: 'error', action: 'subscribe', code: 'reconnect' });
    await vi.advanceTimersByTimeAsync(1000);
    const s3 = last();
    expect(s3).not.toBe(s2);
    s3.open();
    s3.recv({ type: 'subscribed', teamId: 'ta' });

    live.watch('tb');
    expect(last()).toBe(s3);
    expect(s3.sent.at(-1)).toEqual({ action: 'subscribe', teamId: 'tb' });
    s3.recv({ type: 'error', action: 'subscribe', teamId: 'tb', message: 'Not a member' });
    expect(denied).toEqual(['tb']);
    expect(live.status).toBe('off');
    expect(s3.readyState).toBe(3);

    const before = sockets.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBe(before);
    live.dispose();
  });

  it('backs off up to 30 seconds and forces a token refresh after repeated failures', async () => {
    const forced: boolean[] = [];
    const live = make({ getToken: async (f) => { forced.push(f); return 'tok'; } });
    live.watch('ta');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) { last().drop(); await vi.advanceTimersByTimeAsync(30_000); }
    expect(forced[0]).toBe(false);
    expect(forced.slice(2).every(Boolean)).toBe(true);
    live.dispose();
  });

  it('does not connect after stop while waiting for a token', async () => {
    let release!: (t: string) => void;
    const live = make({ getToken: () => new Promise((r) => (release = r)) });
    live.watch('ta');
    live.stop();
    release('tok');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
    live.dispose();
  });
});
