// Phase 0 placeholder. Reads the config.json written at deploy time from the stack outputs.
async function loadConfig() {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

loadConfig().then((cfg) => {
  document.getElementById("env").textContent = cfg.env || "local";
  document.getElementById("build").textContent = cfg.commit ? cfg.commit.slice(0, 7) : "dev server";
});
