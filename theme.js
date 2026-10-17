// Run before styles paint so a dark device never flashes the light interface.
(() => {
  const key = "ai_studio_theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = value => ["system", "light", "dark"].includes(value) ? value : "system";
  let preference = "system";
  try { preference = valid(localStorage.getItem(key)); } catch { /* Storage can be unavailable in private browsers. */ }
  function apply() {
    const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#141518" : "#ffffff");
    const select = document.getElementById("themeSelect");
    if (select) select.value = preference;
    document.dispatchEvent(new CustomEvent("aistudio:themechange", { detail: { theme, preference } }));
  }
  system.addEventListener("change", () => { if (preference === "system") apply(); });
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) { preference = valid(event.newValue); apply(); }
  });
  document.addEventListener("change", event => {
    if (event.target.id !== "themeSelect") return;
    preference = valid(event.target.value);
    try { localStorage.setItem(key, preference); } catch { /* The selection still applies to this tab. */ }
    apply();
  });
  document.addEventListener("DOMContentLoaded", apply, { once: true });
  apply();
})();
