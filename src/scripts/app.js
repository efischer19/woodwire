/**
 * Static JS App — Main Script
 *
 * This is the JavaScript entry point for the application.
 * The default setup uses vanilla JavaScript with no build step.
 *
 * Includes a minimal dark mode toggle as an example of accessible
 * interactive patterns (keyboard navigable, ARIA attributes, screen
 * reader announcements).
 */

"use strict";

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
});

/**
 * Initialize the dark/light theme toggle.
 *
 * Behavior:
 * - Reads the user's saved preference from localStorage.
 * - Falls back to the operating system's preferred color scheme.
 * - Updates the `data-theme` attribute on <html> and persists the choice.
 * - Updates the toggle button's label and ARIA attributes.
 */
function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

  // Determine initial theme: saved preference > OS preference > light
  const saved = localStorage.getItem("theme");
  const initial = saved || (prefersDark.matches ? "dark" : "light");
  applyTheme(initial, toggle);

  // Toggle on click
  toggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next, toggle);
    localStorage.setItem("theme", next);
  });

  // Respond to OS preference changes (only if no saved preference)
  prefersDark.addEventListener("change", (e) => {
    if (!localStorage.getItem("theme")) {
      applyTheme(e.matches ? "dark" : "light", toggle);
    }
  });
}

/**
 * Apply a theme and update the toggle button state.
 *
 * @param {"light" | "dark"} theme - The theme to apply.
 * @param {HTMLElement} toggle - The toggle button element.
 */
function applyTheme(theme, toggle) {
  document.documentElement.setAttribute("data-theme", theme);
  const isDark = theme === "dark";
  toggle.setAttribute("aria-pressed", String(isDark));
  toggle.querySelector(".icon").textContent = isDark ? "☀️" : "🌙";
  toggle.querySelector(".label").textContent = isDark
    ? "Light mode"
    : "Dark mode";
}
