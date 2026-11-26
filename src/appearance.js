// Light or dark (or follow the system), and a colour theme.
// The choice is kept in localStorage; a script in <head> applies it before the
// first paint, and the CSS does the rest with light-dark() and color-scheme.

const STORE_KEY = "paraphe.appearance";
const DEFAULT_THEME = "orange";

/** Colour themes; their colours are in app.css. */
export const THEMES = [
  { id: "orange", name: "Orange" },
  { id: "blue", name: "Blue" },
  { id: "teal", name: "Teal" },
  { id: "green", name: "Green" },
  { id: "pink", name: "Pink" },
  { id: "violet", name: "Violet" },
];

const dark = matchMedia("(prefers-color-scheme: dark)");

function load() {
  try {
    const a = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      mode: ["light", "dark"].includes(a.mode) ? a.mode : "system",
      theme: THEMES.some((t) => t.id === a.theme) ? a.theme : DEFAULT_THEME,
    };
  } catch {
    return { mode: "system", theme: DEFAULT_THEME };
  }
}

export const appearance = load();

/** True when the page is showing its dark side. */
export const isDark = () => appearance.mode === "dark" || (appearance.mode === "system" && dark.matches);

const listeners = [];
export function onAppearanceChange(fn) {
  listeners.push(fn);
}

function apply() {
  const root = document.documentElement;
  if (appearance.mode === "system") delete root.dataset.mode;
  else root.dataset.mode = appearance.mode;
  if (appearance.theme === DEFAULT_THEME) delete root.dataset.theme;
  else root.dataset.theme = appearance.theme;
  for (const fn of listeners) fn();
}

export function setAppearance(change) {
  Object.assign(appearance, change);
  try {
    if (appearance.mode === "system" && appearance.theme === DEFAULT_THEME) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(appearance));
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
  apply();
}

dark.addEventListener("change", () => {
  if (appearance.mode === "system") apply();
});
