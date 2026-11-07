(() => {
  const allowedThemes = new Set(["system", "light", "dark"]);
  let theme = "system";
  try {
    const storedTheme = localStorage.getItem("devops-ledger-theme");
    if (allowedThemes.has(storedTheme)) theme = storedTheme;
  } catch {
    // Theme selection still works for the current page when storage is disabled.
  }
  const root = document.documentElement;
  const systemPreference = window.matchMedia("(prefers-color-scheme: light)");
  const applyTheme = () => {
    root.dataset.themePreference = theme;
    root.dataset.theme = theme === "system" ? (systemPreference.matches ? "light" : "dark") : theme;
    const themeColor = root.dataset.theme === "light" ? "#f0f2ec" : "#171a18";
    document.querySelector('meta[name="theme-color"]').content = themeColor;
  };
  applyTheme();
  systemPreference.addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });
})();