import "./style.css";
import {
  PASSWORD_RULES, configureAuth, currentUser, createAccount, verifyEmail, resendCode,
  logIn, logOut, startReset, finishReset, explain
} from "./auth.js";
import { api, configureApi, accessToken } from "./api.js";
import { createLive } from "./realtime.js";
import { ROLES, ROLE_LABELS, can } from "../../api/src/shared/permissions.ts";

const app = document.getElementById("app");
const state = { cfg: {}, screen: "loading", email: "", user: null, me: null, team: null, invites: [], notice: "", error: "", live: "off" };
let live = null;          // WebSocket client, when this environment has one
let pendingRefresh = false; // a change arrived while someone was mid-edit

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadConfig() {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

function go(screen, extra = {}) {
  Object.assign(state, { screen, error: "", notice: "" }, extra);
  render();
  // Autofocus only the sign-in style forms; on the team page a focused field would hold back live updates.
  const first = screen === "team" || screen === "home" ? null : app.querySelector("input:not([type=hidden])");
  if (first) first.focus();
}

const field = (id, label, type, extra = "") =>
  `<label for="${id}">${label}<input id="${id}" name="${id}" type="${type}" ${extra}></label>`;

const emailField = () => field("email", "Email", "email", `autocomplete="email" required value="${esc(state.email)}"`);

const msgs = () =>
  (state.error ? `<p class="msg error" role="alert">${esc(state.error)}</p>` : "") +
  (state.notice ? `<p class="msg notice" role="status">${esc(state.notice)}</p>` : "");

const views = {
  loading: () => `<p class="muted">Loading…</p>`,

  unconfigured: () => `
    <h2>Sign-in isn't set up here</h2>
    <p class="muted">This copy of the site has no sign-in settings. Use the deployed dev or prod address.</p>`,

  signin: () => `
    <h2>Sign in</h2>
    ${msgs()}
    <form data-form="signin" novalidate>
      ${emailField()}
      ${field("password", "Password", "password", `autocomplete="current-password" required`)}
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <div class="links">
      <button class="link" data-go="forgot">Forgot password?</button>
      <span>New here? <button class="link" data-go="signup">Create your account</button></span>
    </div>`,

  signup: () => `
    <h2>Create your account</h2>
    <p class="muted">Use the email address your coach or team coordinator invited.</p>
    ${msgs()}
    <form data-form="signup" novalidate>
      ${emailField()}
      ${field("password", "Password", "password", `autocomplete="new-password" required minlength="10" aria-describedby="pw-rules"`)}
      <p class="hint" id="pw-rules">${PASSWORD_RULES}</p>
      ${field("confirm", "Confirm password", "password", `autocomplete="new-password" required`)}
      <button class="btn primary" type="submit">Create account</button>
    </form>
    <div class="links"><span>Already have an account? <button class="link" data-go="signin">Sign in</button></span></div>`,

  verify: () => `
    <h2>Check your email</h2>
    <p class="muted">We sent a 6-digit code to <b>${esc(state.email)}</b>. It can take a minute to arrive; check spam if you don't see it.</p>
    ${msgs()}
    <form data-form="verify" novalidate>
      ${field("code", "Verification code", "text", `inputmode="numeric" autocomplete="one-time-code" maxlength="6" required`)}
      <button class="btn primary" type="submit">Verify email</button>
    </form>
    <div class="links"><button class="link" data-act="resend">Send a new code</button><button class="link" data-go="signin">Back to sign in</button></div>`,

  forgot: () => `
    <h2>Reset your password</h2>
    <p class="muted">We'll email you a code to set a new password.</p>
    ${msgs()}
    <form data-form="forgot" novalidate>
      ${emailField()}
      <button class="btn primary" type="submit">Send code</button>
    </form>
    <div class="links"><button class="link" data-go="signin">Back to sign in</button></div>`,

  reset: () => `
    <h2>Set a new password</h2>
    <p class="muted">Enter the code we sent to <b>${esc(state.email)}</b> and choose a new password.</p>
    ${msgs()}
    <form data-form="reset" novalidate>
      ${field("code", "Code", "text", `inputmode="numeric" autocomplete="one-time-code" maxlength="6" required`)}
      ${field("password", "New password", "password", `autocomplete="new-password" required minlength="10" aria-describedby="pw-rules"`)}
      <p class="hint" id="pw-rules">${PASSWORD_RULES}</p>
      <button class="btn primary" type="submit">Save new password</button>
    </form>
    <div class="links"><button class="link" data-go="forgot">Send a new code</button></div>`,

  home: () => {
    const me = state.me;
    const teams = me?.teams ?? [];
    return `
    <h2>Your teams</h2>
    ${msgs()}
    <p class="muted small">Signed in as <b>${esc(state.user?.email)}</b>${me?.clubAdmin ? ` · <span class="pill">Club admin</span>` : ""}</p>
    ${teams.length ? `<ul class="list">${teams.map((t) => `<li><button class="rowbtn" data-team="${esc(t.teamId)}"><b>${esc(t.teamId)}</b><span>${t.roles.map((r) => esc(ROLE_LABELS[r] || r)).join(" · ")}</span></button></li>`).join("")}</ul>`
      : `<p class="muted">You're not on a team yet.${me?.clubAdmin ? " Create one below, or open any team from the list." : " Ask your coordinator for an invite."}</p>`}
    ${me?.clubAdmin ? `
      <h3>All club teams</h3>
      <div id="allTeams" class="muted small">Loading…</div>
      <h3>Create a team</h3>
      <form data-form="createTeam" novalidate>
        ${field("teamId", "Team id", "text", `required placeholder="a5-13tom" pattern="[a-z0-9-]+"`)}
        ${field("name", "Team name", "text", `required placeholder="A5 13 Tom"`)}
        <div class="two">${field("season", "Season", "text", `placeholder="2026-27"`)}${field("age", "Age group", "text", `placeholder="13U"`)}</div>
        <button class="btn primary" type="submit">Create team</button>
      </form>` : ""}
    <div class="links"><button class="link" data-act="signout">Sign out</button></div>`;
  },

  team: () => {
    const t = state.team;
    const you = t.you;
    const manage = can(you.roles, "accounts");
    const roleChecks = (name, sel = []) => `<div class="checks">${ROLES.map((r) => `<label><input type="checkbox" name="${name}" value="${r}" ${sel.includes(r) ? "checked" : ""}> ${esc(ROLE_LABELS[r])}</label>`).join("")}</div>`;
    return `
    <button class="link" data-go="home">‹ Your teams</button>
    <h2>${esc(t.team?.name || t.settings?.teamName || t.teamId)}</h2>
    ${msgs()}
    <p class="muted small">Your roles: ${you.roles.map((r) => esc(ROLE_LABELS[r] || r)).join(", ") || "none"}</p>
    <dl class="kv">
      <dt>Players</dt><dd>${t.players.length}</dd>
      <dt>Events</dt><dd>${t.events.length}</dd>
      <dt>Members</dt><dd>${t.members.length}</dd>
    </dl>
    <p class="muted small">The full team pages move here in Phase 4. This screen checks the API and manages who's on the team.</p>
    ${manage ? `
      <h3>Members</h3>
      <ul class="list">${t.members.map((m) => `
        <li class="member">
          <div><b>${esc(m.email || m.person || m.sub)}</b><div class="muted small">${m.roles.map((r) => esc(ROLE_LABELS[r] || r)).join(", ")}${m.pid ? ` · family ${esc(m.pid)}` : ""}</div></div>
          ${m.sub ? `<details><summary>Change</summary>
            <form data-form="member" data-sub="${esc(m.sub)}" novalidate>
              ${roleChecks("roles", m.roles)}
              ${field("pid", "Family (player id)", "text", `value="${esc(m.pid || "")}"`)}
              <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn danger" type="button" data-act="removeMember" data-sub="${esc(m.sub)}">Remove from team</button></div>
            </form>
          </details>` : ""}
        </li>`).join("") || `<li class="muted">No members yet.</li>`}</ul>
      <h3>Invites</h3>
      <ul class="list">${state.invites.map((i) => `<li class="member"><div><b>${esc(i.email)}</b><div class="muted small">${(i.roles || []).map((r) => esc(ROLE_LABELS[r] || r)).join(", ")}${i.pid ? ` · family ${esc(i.pid)}` : ""}</div></div><button class="link" data-act="cancelInvite" data-email="${esc(i.email)}">Cancel</button></li>`).join("") || `<li class="muted">No pending invites.</li>`}</ul>
      <form data-form="invite" novalidate>
        ${field("email", "Email to invite", "email", `required autocomplete="off"`)}
        ${roleChecks("roles", ["parent"])}
        ${field("pid", "Family (player id, for parents)", "text", `placeholder="p12"`)}
        <button class="btn primary" type="submit">Send invite</button>
      </form>
      <p class="muted small">Invites don't send an email yet. Tell the person to create an account at this site with that address.</p>` : ""}`;
  }
};

function render() {
  const env = state.cfg.env || "local";
  app.innerHTML = `
    <header class="top">
      <div><p class="eyebrow">A5 Volleyball</p><h1>Team Hub</h1></div>
      <div class="badges">${liveBadge()}${env !== "prod" ? `<span class="env">${esc(env)}</span>` : ""}</div>
    </header>
    <section class="card">${(views[state.screen] || views.loading)()}</section>
    <footer class="foot muted">${state.cfg.commit ? `Build ${esc(state.cfg.commit.slice(0, 7))}` : ""}</footer>`;
}

// ---------- Live updates ----------
const LIVE_TEXT = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" };
const REFRESH_ON = new Set(["*", "members", "invites", "players", "events", "settings"]);

function liveBadge() {
  if (state.screen !== "team" || state.live === "off") return `<span id="live" class="live"></span>`;
  const cls = state.live === "live" ? "live-on" : "live-wait";
  const inner = pendingRefresh
    ? `<button class="link" data-act="refreshNow">New changes · Show</button>`
    : esc(LIVE_TEXT[state.live]);
  return `<span id="live" class="live ${cls}" role="status" title="Changes others make appear here automatically">${inner}</span>`;
}
const paintLive = () => { const el = document.getElementById("live"); if (el) el.outerHTML = liveBadge(); };

// Someone is typing, has ticked a box, or has a field focused: don't redraw under them.
function isEditing() {
  const a = document.activeElement;
  if (a && app.contains(a) && a.closest("form") && a.matches("input,select,textarea")) return true;
  return [...app.querySelectorAll("form[data-form] input, form[data-form] textarea")].some((e) =>
    e.type === "checkbox" || e.type === "radio" ? e.checked !== e.defaultChecked
      : !["hidden", "submit", "button"].includes(e.type) && e.value !== e.defaultValue);
}

async function refreshTeam(collections, { force = false } = {}) {
  if (state.screen !== "team" || !state.team) return;
  if (!force && !collections.some((c) => REFRESH_ON.has(c))) return;
  if (!force && isEditing()) { pendingRefresh = true; return paintLive(); }
  pendingRefresh = false;
  const id = state.team.teamId;
  try {
    const team = await api("GET", `/teams/${encodeURIComponent(id)}`);
    const invites = can(team.you.roles, "accounts") ? (await api("GET", `/teams/${encodeURIComponent(id)}/invites`)).invites : [];
    if (state.screen !== "team" || state.team?.teamId !== id) return;
    const open = [...app.querySelectorAll("details[open] form[data-sub]")].map((f) => f.dataset.sub);
    const scrollY = window.scrollY;
    Object.assign(state, { team, invites });
    render();
    for (const sub of open) app.querySelector(`form[data-sub="${CSS.escape(sub)}"]`)?.closest("details")?.setAttribute("open", "");
    window.scrollTo(0, scrollY);
    app.querySelector(".card")?.classList.add("fresh");
  } catch (err) {
    if (err.status === 403 || err.status === 404) { live?.stop(); return showHome("You no longer have access to that team."); }
    console.warn("Live refresh failed", err);
  }
}

// Apply a held-back change once the person steps out of the form without leaving edits behind.
app.addEventListener("focusout", () => setTimeout(() => { if (pendingRefresh && !isEditing()) refreshTeam(["*"]); }, 0));

function startLive(cfg) {
  if (!cfg.wsUrl || typeof WebSocket === "undefined") return;
  live = createLive({
    url: cfg.wsUrl,
    getToken: accessToken,
    onChange: (teamId, collections) => { if (state.team?.teamId === teamId) refreshTeam(collections); },
    onStatus: (s) => { state.live = s; paintLive(); },
    onDenied: (teamId) => { if (state.screen === "team" && state.team?.teamId === teamId) showHome("You no longer have access to that team."); }
  });
}

async function busy(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Working…";
  try {
    await fn();
  } catch (err) {
    console.warn(err);
    state.error = explain(err);
    render();
  } finally {
    const b = app.querySelector("button[type=submit]");
    if (b) { b.disabled = false; if (b.textContent === "Working…") b.textContent = label; }
  }
}

async function showHome(notice = "") {
  live?.stop();
  pendingRefresh = false;
  state.user = await currentUser();
  if (!state.user) return go("signin", { notice });
  try {
    state.me = await api("GET", "/me");
    if (state.me.acceptedInvites) notice = notice || `You've been added to ${state.me.acceptedInvites} team${state.me.acceptedInvites > 1 ? "s" : ""}.`;
  } catch (err) {
    state.me = { teams: [] };
    return go("home", { error: err.message, notice });
  }
  go("home", { notice });
  if (state.me.clubAdmin) loadAllTeams();
}

async function loadAllTeams() {
  try {
    const { teams } = await api("GET", "/teams");
    const el = document.getElementById("allTeams");
    if (el) el.innerHTML = teams.length
      ? `<ul class="list">${teams.map((t) => `<li><button class="rowbtn" data-team="${esc(t.teamId)}"><b>${esc(t.name)}</b><span>${esc(t.teamId)}${t.age ? " · " + esc(t.age) : ""}</span></button></li>`).join("")}</ul>`
      : "No teams yet.";
  } catch (err) {
    const el = document.getElementById("allTeams");
    if (el) el.textContent = err.message;
  }
}

async function openTeam(teamId, notice = "") {
  try {
    const team = await api("GET", `/teams/${encodeURIComponent(teamId)}`);
    const invites = can(team.you.roles, "accounts") ? (await api("GET", `/teams/${encodeURIComponent(teamId)}/invites`)).invites : [];
    pendingRefresh = false;
    go("team", { team, invites, notice });
    live?.watch(teamId);
  } catch (err) {
    go("home", { error: err.message });
  }
}

app.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const v = Object.fromEntries(new FormData(form).entries());
  if (v.email !== undefined) state.email = String(v.email).trim();

  const handlers = {
    signin: async () => {
      const step = await logIn(v.email, v.password);
      if (step === "DONE") return showHome();
      if (step === "CONFIRM_SIGN_UP") { await resendCode(v.email); return go("verify", { notice: "Verify your email first. We've sent you a new code." }); }
      if (step === "RESET_PASSWORD") { await startReset(v.email); return go("reset"); }
      state.error = "Sign-in needs a step this page doesn't support yet."; render();
    },
    signup: async () => {
      if (v.password !== v.confirm) { state.error = "The passwords don't match."; return render(); }
      const step = await createAccount(v.email, v.password);
      if (step === "CONFIRM_SIGN_UP") return go("verify");
      return showHome();
    },
    verify: async () => {
      const next = await verifyEmail(state.email, String(v.code));
      if (next === "SIGNED_IN") return showHome("Email verified. Welcome to the Team Hub.");
      go("signin", { notice: "Email verified. Sign in to continue." });
    },
    forgot: async () => {
      await startReset(v.email);
      go("reset", { notice: "If that email has an account, a code is on its way." });
    },
    reset: async () => {
      await finishReset(state.email, String(v.code), v.password);
      go("signin", { notice: "Password updated. Sign in with your new password." });
    },
    createTeam: async () => {
      await api("POST", "/teams", { teamId: String(v.teamId).trim().toLowerCase(), name: v.name, season: v.season, age: v.age });
      await openTeam(String(v.teamId).trim().toLowerCase(), "Team created.");
    },
    invite: async () => {
      const roles = new FormData(form).getAll("roles");
      await api("POST", `/teams/${encodeURIComponent(state.team.teamId)}/invites`, { email: v.email, roles, pid: v.pid || undefined });
      await openTeam(state.team.teamId, `Invited ${String(v.email).trim().toLowerCase()}.`);
    },
    member: async () => {
      const roles = new FormData(form).getAll("roles");
      await api("PUT", `/teams/${encodeURIComponent(state.team.teamId)}/members/${encodeURIComponent(form.dataset.sub)}`, { roles, pid: v.pid || undefined });
      await openTeam(state.team.teamId, "Roles saved.");
    }
  };
  const h = handlers[form.dataset.form];
  if (h) busy(form, h);
});

app.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-go],[data-act],[data-team]");
  if (!el) return;
  if (el.dataset.team) return openTeam(el.dataset.team);
  if (el.dataset.go === "home" && state.user) return showHome();
  if (el.dataset.go) return go(el.dataset.go);
  if (el.dataset.act === "refreshNow") return refreshTeam(["*"], { force: true });
  if (el.dataset.act === "signout") { live?.stop(); await logOut(); return go("signin", { notice: "You've signed out.", user: null }); }
  if (el.dataset.act === "removeMember" || el.dataset.act === "cancelInvite") {
    if (!el.classList.contains("confirm")) { el.classList.add("confirm"); el.textContent = "Tap again to confirm"; return; }
    try {
      const t = encodeURIComponent(state.team.teamId);
      if (el.dataset.act === "removeMember") await api("DELETE", `/teams/${t}/members/${encodeURIComponent(el.dataset.sub)}`);
      else await api("DELETE", `/teams/${t}/invites/${encodeURIComponent(el.dataset.email)}`);
      await openTeam(state.team.teamId, el.dataset.act === "removeMember" ? "Removed from the team." : "Invite cancelled.");
    } catch (err) { state.error = err.message; render(); }
    return;
  }
  if (el.dataset.act === "resend") {
    try { await resendCode(state.email); state.notice = "A new code is on its way."; state.error = ""; }
    catch (err) { state.error = explain(err); }
    render();
  }
});

(async () => {
  render();
  state.cfg = await loadConfig();
  if (!configureAuth(state.cfg)) return go("unconfigured");
  configureApi(state.cfg);
  startLive(state.cfg);
  await showHome();
})();
