import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import Island from "./Island";
import {
  applyTheme,
  getStoredTheme,
  syncThemeFromSettings,
} from "@/lib/utils/theme";
import type { Theme } from "@/bindings";
import "@/i18n";

// A separate webview from the settings window. The island itself is always
// black, but shared components read `data-theme`: last-known theme before
// render (shared localStorage), reconcile with the setting, follow changes.
applyTheme(getStoredTheme());
syncThemeFromSettings();
listen<Theme>("theme-changed", (event) => applyTheme(event.payload));

// The overlay floats over other apps, so a stray right-click must not open the
// webview's default menu (Reload, Save as, Print, ...). Kept in dev for Inspect.
if (import.meta.env.PROD) {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Island />
  </React.StrictMode>,
);
