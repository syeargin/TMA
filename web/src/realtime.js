// Live updates over the Team Hub WebSocket.
//
// The socket only carries short "something changed" notices ({type:"changed", teamId, collections}).
// The page then re-reads through the REST API, so the API stays the single place that decides who
// may see what. If the socket drops, we reconnect with backoff and refetch once, since notices sent
// while we were away are lost.

const PING_MS = 5 * 60 * 1000;   // API Gateway closes sockets idle for 10 minutes
const COALESCE_MS = 300;         // one refresh for a burst of writes
const MAX_BACKOFF_MS = 30_000;

/**
 * @param {{ url: string, getToken: (force?: boolean) => Promise<string|undefined>,
 *           onChange: (teamId: string, collections: string[]) => void,
 *           onStatus?: (status: "off"|"connecting"|"live"|"reconnecting") => void,
 *           onDenied?: (teamId: string, message: string) => void }} opts
 */
export function createLive({ url, getToken, onChange, onStatus = () => {}, onDenied = () => {} }) {
  let ws = null;
  let teamId = null;          // the team we want to hear about; null = we want no socket
  let attempts = 0;
  let everSubscribed = false; // after the first subscribe, a resubscribe means we may have missed notices
  let pingTimer = null, retryTimer = null, flushTimer = null;
  let pending = new Set();
  let status = "off";

  const setStatus = (s) => { if (s !== status) { status = s; onStatus(s); } };
  const sendJson = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  function clearTimers() {
    clearInterval(pingTimer); clearTimeout(retryTimer); pingTimer = retryTimer = null;
  }

  async function open() {
    clearTimers();
    if (!teamId || !url) return;
    setStatus(attempts ? "reconnecting" : "connecting");
    let token;
    try { token = await getToken(attempts >= 2); } catch { token = undefined; }
    if (!teamId) return;                       // stopped while we waited for the token
    if (!token) return scheduleRetry();
    const sock = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      sendJson({ action: "subscribe", teamId });
      pingTimer = setInterval(() => sendJson({ action: "ping" }), PING_MS);
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "subscribed" && msg.teamId === teamId) {
        const catchUp = everSubscribed;
        everSubscribed = true;
        attempts = 0;
        setStatus("live");
        if (catchUp) queue(["*"]);
      } else if (msg.type === "changed" && msg.teamId === teamId) {
        queue(msg.collections || ["*"]);
      } else if (msg.type === "error" && msg.code === "reconnect") {
        sock.close();                          // server forgot this socket; onclose reconnects
      } else if (msg.type === "error" && msg.action === "subscribe") {
        const denied = teamId;
        stop();
        onDenied(denied, msg.message || "You can't follow this team.");
      }
    };
    sock.onclose = () => {
      if (ws !== sock) return;                 // an older socket we already replaced
      ws = null;
      clearInterval(pingTimer); pingTimer = null;
      if (teamId) scheduleRetry();
    };
    sock.onerror = () => { /* onclose follows and handles the retry */ };
  }

  function scheduleRetry() {
    attempts += 1;
    setStatus("reconnecting");
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1));
    retryTimer = setTimeout(open, base / 2 + Math.random() * base / 2);
  }

  function queue(collections) {
    collections.forEach((c) => pending.add(c));
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      const list = [...pending];
      pending = new Set();
      if (teamId) onChange(teamId, list);
    }, COALESCE_MS);
  }

  /** Follow one team. Reuses the open socket when switching teams. */
  function watch(next) {
    if (!url) return;
    if (next === teamId && (ws || retryTimer)) return;
    const switching = teamId && next !== teamId;
    teamId = next;
    everSubscribed = false;
    if (switching && ws?.readyState === WebSocket.OPEN) { setStatus("connecting"); sendJson({ action: "subscribe", teamId }); return; }
    if (!ws) { attempts = 0; open(); }
  }

  /** Close the socket (leaving the team page or signing out). */
  function stop() {
    teamId = null;
    clearTimers(); clearTimeout(flushTimer); pending = new Set();
    const sock = ws; ws = null;
    if (sock) sock.close(1000, "done");
    setStatus("off");
  }

  // Come back quickly when the laptop wakes or the network returns, instead of waiting out a backoff.
  const nudge = () => { if (teamId && !ws) { attempts = Math.min(attempts, 1); open(); } };
  window.addEventListener("online", nudge);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") nudge(); });

  return { watch, stop, get status() { return status; } };
}
