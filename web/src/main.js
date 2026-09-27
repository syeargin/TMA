import "./style.css";
import {
  PASSWORD_RULES, configureAuth, currentUser, createAccount, verifyEmail, resendCode,
  logIn, logOut, startReset, finishReset, explain
} from "./auth.js";

const app = document.getElementById("app");
const state = { cfg: {}, screen: "loading", email: "", user: null, notice: "", error: "" };

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
  const first = app.querySelector("input:not([type=hidden])");
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

  home: () => `
    <h2>You're signed in</h2>
    ${msgs()}
    <dl class="kv">
      <dt>Email</dt><dd>${esc(state.user?.email)}</dd>
      <dt>Account id</dt><dd class="mono">${esc(state.user?.sub)}</dd>
    </dl>
    <p class="muted">Your teams and roles were linked from your invite. The team pages move here in the next phases.</p>
    <button class="btn" data-act="signout">Sign out</button>`
};

function render() {
  const env = state.cfg.env || "local";
  app.innerHTML = `
    <header class="top">
      <div><p class="eyebrow">A5 Volleyball</p><h1>Team Hub</h1></div>
      ${env !== "prod" ? `<span class="env">${esc(env)}</span>` : ""}
    </header>
    <section class="card">${(views[state.screen] || views.loading)()}</section>
    <footer class="foot muted">${state.cfg.commit ? `Build ${esc(state.cfg.commit.slice(0, 7))}` : ""}</footer>`;
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
  state.user = await currentUser();
  go(state.user ? "home" : "signin", { notice });
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
    }
  };
  const h = handlers[form.dataset.form];
  if (h) busy(form, h);
});

app.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-go],[data-act]");
  if (!el) return;
  if (el.dataset.go) return go(el.dataset.go);
  if (el.dataset.act === "signout") { await logOut(); return go("signin", { notice: "You've signed out.", user: null }); }
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
  await showHome();
})();
