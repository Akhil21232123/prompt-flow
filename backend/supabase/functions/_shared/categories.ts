// What kind of app the user is typing into. Mirrors the desktop rules in
// src-tauri/src/flow/app_context.rs and adds iOS bundle ids and Android
// package names for the mobile apps.

import type { AppCategory, AppContext } from "./types.ts";

const RULES: Array<[string, AppCategory]> = [
  // Email
  ["com.apple.mail", "email"],
  ["com.apple.mobilemail", "email"],
  ["com.microsoft.outlook", "email"],
  ["com.microsoft.office.outlook", "email"],
  ["com.google.android.gm", "email"],
  ["com.google.gmail", "email"],
  ["com.readdle.smartemail", "email"],
  ["com.readdle.smartemail-mac", "email"],
  ["com.superhuman.electron", "email"],
  ["com.superhuman.mail", "email"],
  ["ch.protonmail.android", "email"],
  // Work chat
  ["com.tinyspeck.slackmacgap", "work_chat"],
  ["com.tinyspeck.chatlyio", "work_chat"],
  ["com.slack", "work_chat"],
  ["com.microsoft.teams", "work_chat"],
  ["com.microsoft.teams2", "work_chat"],
  ["com.microsoft.skype.teams", "work_chat"],
  ["us.zoom.xos", "work_chat"],
  ["us.zoom.videomeetings", "work_chat"],
  ["com.linear", "work_chat"],
  ["app.linear", "work_chat"],
  // Personal chat
  ["com.apple.mobilesms", "personal_chat"],
  ["net.whatsapp.whatsapp", "personal_chat"],
  ["com.whatsapp", "personal_chat"],
  ["com.whatsapp.w4b", "personal_chat"],
  ["desktop.whatsapp", "personal_chat"],
  ["ru.keepcoder.telegram", "personal_chat"],
  ["ph.telegra.telegraph", "personal_chat"],
  ["org.telegram.messenger", "personal_chat"],
  ["org.telegram.desktop", "personal_chat"],
  ["com.hnc.discord", "personal_chat"],
  ["com.discord", "personal_chat"],
  ["org.whispersystems.signal-desktop", "personal_chat"],
  ["org.thoughtcrime.securesms", "personal_chat"],
  ["org.whispersystems.signal", "personal_chat"],
  ["com.facebook.orca", "personal_chat"],
  ["com.facebook.archon", "personal_chat"],
  ["com.instagram.android", "personal_chat"],
  ["com.burbn.instagram", "personal_chat"],
  ["com.google.android.apps.messaging", "personal_chat"],
  ["com.tencent.xinwechat", "personal_chat"],
  // Code editors
  ["com.todesktop.230313mzl4w4u92", "code"],
  ["com.exafunction.windsurf", "code"],
  ["com.microsoft.vscode", "code"],
  ["com.microsoft.vscodeinsiders", "code"],
  ["dev.zed.zed", "code"],
  ["com.apple.dt.xcode", "code"],
  ["com.jetbrains.*", "code"],
  ["com.github.android", "code"],
  ["com.github.stormbreaker.prod", "code"],
  ["com.replit.app", "code"],
  // Terminals
  ["com.apple.terminal", "terminal"],
  ["com.googlecode.iterm2", "terminal"],
  ["dev.warp.warp-stable", "terminal"],
  ["com.mitchellh.ghostty", "terminal"],
  ["com.termux", "terminal"],
  ["com.blink.blinkshell", "terminal"],
  // AI chats
  ["com.anthropic.claudefordesktop", "ai_chat"],
  ["com.anthropic.claude", "ai_chat"],
  ["com.openai.chat", "ai_chat"],
  ["com.openai.chatgpt", "ai_chat"],
  ["ai.perplexity.mac", "ai_chat"],
  ["ai.perplexity.app.android", "ai_chat"],
  ["ai.perplexity.app", "ai_chat"],
  ["com.google.android.apps.bard", "ai_chat"],
  ["com.google.gemini", "ai_chat"],
  ["ai.x.grok", "ai_chat"],
  ["com.deepseek.chat", "ai_chat"],
  // Documents and notes
  ["com.apple.iwork.pages", "docs"],
  ["com.apple.notes", "docs"],
  ["com.apple.mobilenotes", "docs"],
  ["com.microsoft.word", "docs"],
  ["com.microsoft.office.word", "docs"],
  ["notion.id", "docs"],
  ["notion.so", "docs"],
  ["md.obsidian", "docs"],
  ["com.google.android.apps.docs.editors.docs", "docs"],
  ["com.google.docs", "docs"],
  ["com.google.android.keep", "docs"],
];

const TITLE_RULES: Array<[string, AppCategory]> = [
  ["claude", "ai_chat"],
  ["chatgpt", "ai_chat"],
  ["gemini", "ai_chat"],
  ["perplexity", "ai_chat"],
  ["grok", "ai_chat"],
  ["lovable", "ai_chat"],
  ["github", "code"],
  ["replit", "code"],
  ["gmail", "email"],
  ["outlook", "email"],
  ["slack", "work_chat"],
  ["linear", "work_chat"],
  ["whatsapp", "personal_chat"],
  ["telegram", "personal_chat"],
  ["google docs", "docs"],
  ["notion", "docs"],
];

const BROWSERS = new Set([
  "com.apple.safari",
  "com.apple.mobilesafari",
  "com.google.chrome",
  "com.google.chrome.ios",
  "com.android.chrome",
  "company.thebrowser.browser",
  "company.thebrowser.dia",
  "org.mozilla.firefox",
  "org.mozilla.ios.firefox",
  "com.brave.browser",
  "com.microsoft.edgemac",
  "com.microsoft.emmx",
  "com.sec.android.app.sbrowser",
  "com.openai.atlas",
]);

const CATEGORIES: AppCategory[] = [
  "email",
  "work_chat",
  "personal_chat",
  "code",
  "terminal",
  "ai_chat",
  "docs",
  "other",
];

function matches(rule: string, id: string): boolean {
  if (rule.endsWith(".*")) {
    const prefix = rule.slice(0, -2);
    return id.startsWith(prefix) && id.length > prefix.length;
  }
  return rule === id;
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(haystack);
}

/** Server-side category; trusts the client's guess only when the app is unknown. */
export function classify(app: AppContext | undefined): AppCategory {
  if (!app) return "other";
  const id = (app.bundle_id ?? "").trim().toLowerCase();
  const title = (app.title ?? "").toLowerCase();

  if (BROWSERS.has(id)) {
    const hit = TITLE_RULES.find(([n]) => containsWord(title, n));
    return hit ? hit[1] : "other";
  }
  if (id) {
    const hit = RULES.find(([rule]) => matches(rule, id));
    if (hit) return hit[1];
  }
  if (app.category && CATEGORIES.includes(app.category)) return app.category;
  return "other";
}

export function isAiTarget(c: AppCategory): boolean {
  return c === "ai_chat" || c === "code" || c === "terminal";
}

export function supportsFileTags(app: AppContext | undefined): boolean {
  const id = (app?.bundle_id ?? "").toLowerCase();
  const name = (app?.name ?? "").toLowerCase();
  return (
    id === "com.todesktop.230313mzl4w4u92" ||
    id === "com.exafunction.windsurf" ||
    id.startsWith("com.microsoft.vscode") ||
    name === "cursor" ||
    name === "windsurf"
  );
}

export function describeApp(app: AppContext): string {
  let out = app.name?.trim() || "Unknown app";
  if (app.bundle_id) out += ` (${app.bundle_id})`;
  if (app.title) out += ` — window "${app.title.slice(0, 160)}"`;
  return out;
}
