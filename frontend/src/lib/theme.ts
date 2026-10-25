/**
 * Appearance preference (More menu → Appearance): System, Light or Dark. Stored only in this
 * browser; "system" follows the operating system's light/dark setting. The token blocks in
 * globals.css read `data-theme` on <html>.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_KEY = "cse-hub:theme";

export function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
  try {
    if (preference === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Not remembered (storage unavailable); the choice still applies to this page.
  }
}

/** Runs before first paint (inline in <head>) so a chosen theme never flashes the other one. */
export const THEME_BOOTSTRAP = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
