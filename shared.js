export const STORAGE_KEYS = {
  settings: "maimemo_settings",
  words: "maimemo_words",
  lastSync: "maimemo_last_sync",
  blacklist: "maimemo_highlight_blacklist"
};

export const DEFAULT_SETTINGS = {
  maimemoToken: "",
  currentNotepadId: "",
  currentNotepadTitle: "",
  syncIntervalHours: 6
};

export function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const syncIntervalHours = Number.isFinite(Number(merged.syncIntervalHours))
    ? Math.max(1, Math.min(168, Math.round(Number(merged.syncIntervalHours))))
    : DEFAULT_SETTINGS.syncIntervalHours;

  const currentNotepadId = String(merged.currentNotepadId || "").trim();

  return {
    maimemoToken: String(merged.maimemoToken || "").trim(),
    currentNotepadId,
    currentNotepadTitle: currentNotepadId ? String(merged.currentNotepadTitle || "").trim() : "",
    syncIntervalHours
  };
}

export function normalizeStoredWords(words) {
  return Array.from(
    new Set(
      (Array.isArray(words) ? words : [])
        .map(word => String(word || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}
