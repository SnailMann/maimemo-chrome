import { appendWordToNotepad, extractWordsFromNotepad, fetchNotepadDetail, getMaimemoClient, listAllNotepads, normalizeWord } from "./maimemo.js";
import { DEFAULT_SETTINGS, STORAGE_KEYS, normalizeSettings, normalizeStoredWords } from "./shared.js";

const CONTEXT_MENU_ID = "maimemo-add-to-current-notepad";
const PERIODIC_SYNC_ALARM = "maimemo-sync-current-notepad";
let currentNotepadJobChain = Promise.resolve();

function removeAllContextMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
}

function createContextMenu(options) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(options, () => resolve());
  });
}

function runCurrentNotepadJob(job) {
  const queued = currentNotepadJobChain
    .catch(() => {})
    .then(job);

  currentNotepadJobChain = queued.catch(() => {});
  return queued;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return normalizeSettings(stored[STORAGE_KEYS.settings] || DEFAULT_SETTINGS);
}

async function saveSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: normalized });
  return normalized;
}

async function saveTokenSettings(payload) {
  const current = await getSettings();
  const next = await saveSettings({
    ...current,
    maimemoToken: payload && payload.maimemoToken ? String(payload.maimemoToken) : ""
  });
  schedulePeriodicSync(next);
  return next;
}

async function saveCurrentNotepadSelection(payload) {
  const current = await getSettings();
  if (!current.maimemoToken) throw new Error("MISSING_TOKEN");

  const next = normalizeSettings({
    ...current,
    currentNotepadId: payload && payload.currentNotepadId ? String(payload.currentNotepadId) : "",
    currentNotepadTitle: payload && payload.currentNotepadTitle ? String(payload.currentNotepadTitle) : "",
    syncIntervalHours: payload && payload.syncIntervalHours
  });

  if (!next.currentNotepadId) throw new Error("MISSING_CURRENT_NOTEPAD");

  await saveSettings(next);
  schedulePeriodicSync(next);

  try {
    const sync = await syncCurrentNotepad();
    return {
      settings: sync.settings,
      sync
    };
  } catch (error) {
    return {
      settings: next,
      sync: null,
      syncError: toErrorPayload(error)
    };
  }
}

async function getCachedWords() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.words);
  return normalizeStoredWords(stored[STORAGE_KEYS.words]);
}

async function getHighlightBlacklist() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.blacklist);
  return normalizeStoredWords(stored[STORAGE_KEYS.blacklist]);
}

async function setCachedWords(words) {
  const normalizedWords = normalizeStoredWords(words);
  const lastSync = Date.now();
  await chrome.storage.local.set({
    [STORAGE_KEYS.words]: normalizedWords,
    [STORAGE_KEYS.lastSync]: lastSync
  });
  return { words: normalizedWords, lastSync };
}

async function addWordToHighlightBlacklist(rawWord) {
  const word = normalizeWord(rawWord);
  if (!word) throw new Error("INVALID_WORD");

  const blacklist = await getHighlightBlacklist();
  if (blacklist.includes(word)) {
    return {
      word,
      alreadyExists: true,
      blacklist
    };
  }

  const nextBlacklist = normalizeStoredWords([...blacklist, word]);
  await chrome.storage.local.set({
    [STORAGE_KEYS.blacklist]: nextBlacklist
  });

  return {
    word,
    alreadyExists: false,
    blacklist: nextBlacklist
  };
}

async function getLastSync() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.lastSync);
  return stored[STORAGE_KEYS.lastSync] || null;
}

function isReadyForSync(settings) {
  return !!(settings.maimemoToken && settings.currentNotepadId);
}

function clearPeriodicSyncAlarm() {
  try {
    chrome.alarms.clear(PERIODIC_SYNC_ALARM);
  } catch {}
}

function schedulePeriodicSync(settings) {
  clearPeriodicSyncAlarm();
  if (!isReadyForSync(settings)) return;

  try {
    chrome.alarms.create(PERIODIC_SYNC_ALARM, {
      periodInMinutes: Math.max(1, Math.floor(Number(settings.syncIntervalHours || 6) * 60))
    });
  } catch {}
}

async function ensureContextMenu() {
  await removeAllContextMenus();
  await createContextMenu({
    id: CONTEXT_MENU_ID,
    title: "加入墨墨词本",
    contexts: ["selection"]
  });
}

async function syncCurrentNotepadNow() {
  const settings = await getSettings();
  if (!settings.maimemoToken) throw new Error("MISSING_TOKEN");
  if (!settings.currentNotepadId) throw new Error("MISSING_CURRENT_NOTEPAD");

  const client = getMaimemoClient(settings);
  const notepad = await fetchNotepadDetail(client, settings.currentNotepadId);
  if (!notepad) throw new Error("NOTEPAD_NOT_FOUND");

  const nextSettings = normalizeSettings({
    ...settings,
    currentNotepadTitle: notepad.title || settings.currentNotepadTitle
  });

  if (nextSettings.currentNotepadTitle !== settings.currentNotepadTitle) {
    await saveSettings(nextSettings);
  }

  const cache = await setCachedWords(extractWordsFromNotepad(notepad));
  return {
    settings: nextSettings,
    notepad,
    words: cache.words,
    lastSync: cache.lastSync
  };
}

async function syncCurrentNotepad() {
  return runCurrentNotepadJob(() => syncCurrentNotepadNow());
}

async function addWordToCurrentNotepadNow(rawWord) {
  const settings = await getSettings();
  if (!settings.maimemoToken) throw new Error("MISSING_TOKEN");
  if (!settings.currentNotepadId) throw new Error("MISSING_CURRENT_NOTEPAD");

  const word = normalizeWord(rawWord);
  if (!word) throw new Error("INVALID_WORD");

  const client = getMaimemoClient(settings);
  const result = await appendWordToNotepad(client, settings.currentNotepadId, word);
  const nextSettings = normalizeSettings({
    ...settings,
    currentNotepadTitle: result.notepad && result.notepad.title
      ? result.notepad.title
      : settings.currentNotepadTitle
  });

  if (nextSettings.currentNotepadTitle !== settings.currentNotepadTitle) {
    await saveSettings(nextSettings);
  }

  const cache = await setCachedWords(result.words);
  return {
    settings: nextSettings,
    word: result.word,
    alreadyExists: result.alreadyExists,
    words: cache.words,
    lastSync: cache.lastSync
  };
}

async function addWordToCurrentNotepad(rawWord) {
  return runCurrentNotepadJob(() => addWordToCurrentNotepadNow(rawWord));
}

async function getOptionsState() {
  const settings = await getSettings();
  const words = await getCachedWords();
  const lastSync = await getLastSync();
  return { settings, words, lastSync };
}

function toErrorPayload(error) {
  const message = String((error && error.message) || error || "UNKNOWN_ERROR");
  const [code, ...rest] = message.split(": ");
  return {
    ok: false,
    error: code || "UNKNOWN_ERROR",
    detail: rest.join(": ")
  };
}

function toUserMessage(error) {
  const code = String((error && error.message) || error || "UNKNOWN_ERROR");
  if (code.startsWith("MISSING_TOKEN")) return "请先在设置页填写墨墨开放 API Token。";
  if (code.startsWith("MISSING_CURRENT_NOTEPAD")) return "请先在设置页选择当前云词本。";
  if (code.startsWith("INVALID_WORD")) return "请先选中一个英文单词或词组。";
  if (code.startsWith("NOTEPAD_NOT_FOUND")) return "当前云词本不存在，请重新选择。";
  if (code.startsWith("common_unauthorized")) return "墨墨开放 API Token 无效或已失效，请重新保存。";
  if (code.startsWith("common_not_found")) return "当前云词本不存在或已被删除，请重新选择。";
  if (code.startsWith("common_invalid_param")) return "墨墨接口拒绝了本次请求参数，请重新获取云词本后再试。";
  return `操作失败：${code}`;
}

function toResponseErrorPayload(error) {
  return {
    ...toErrorPayload(error),
    userMessage: toUserMessage(error)
  };
}

function notifyTab(tabId, message, tone = "info") {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: "SHOW_TOAST",
    payload: { message, tone }
  }).catch(() => {});
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== PERIODIC_SYNC_ALARM) return;
  try {
    await syncCurrentNotepad();
  } catch {}
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info || info.menuItemId !== CONTEXT_MENU_ID) return;

  try {
    const pendingWord = normalizeWord(info.selectionText || "");
    if (pendingWord) {
      notifyTab(tab && tab.id, `正在添加 “${pendingWord}”...`, "info");
    }

    const result = await addWordToCurrentNotepad(info.selectionText || "");
    notifyTab(
      tab && tab.id,
      result.alreadyExists
        ? `“${result.word}” 已经在当前云词本中了`
        : `已添加 “${result.word}” 到当前云词本`,
      result.alreadyExists ? "info" : "success"
    );
  } catch (error) {
    notifyTab(tab && tab.id, toUserMessage(error), "error");
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureContextMenu();
  const settings = await getSettings();
  schedulePeriodicSync(settings);
  if (isReadyForSync(settings)) {
    try {
      await syncCurrentNotepad();
    } catch {}
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureContextMenu();
  const settings = await getSettings();
  schedulePeriodicSync(settings);
  if (isReadyForSync(settings)) {
    try {
      await syncCurrentNotepad();
    } catch {}
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

(async () => {
  try {
    await ensureContextMenu();
    const settings = await getSettings();
    schedulePeriodicSync(settings);
  } catch {}
})();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: "UNKNOWN_MESSAGE" });
      return;
    }

    if (message.type === "GET_OPTIONS_STATE") {
      sendResponse({ ok: true, ...(await getOptionsState()) });
      return;
    }

    if (message.type === "SAVE_TOKEN") {
      try {
        const settings = await saveTokenSettings(message.payload || {});
        sendResponse({ ok: true, settings });
      } catch (error) {
        sendResponse(toResponseErrorPayload(error));
      }
      return;
    }

    if (message.type === "LIST_NOTEPADS") {
      try {
        const settings = normalizeSettings({
          ...(await getSettings()),
          maimemoToken: message.payload && message.payload.maimemoToken
            ? String(message.payload.maimemoToken)
            : undefined
        });
        if (!settings.maimemoToken) throw new Error("MISSING_TOKEN");
        const client = getMaimemoClient(settings);
        const notepads = await listAllNotepads(client);
        sendResponse({ ok: true, notepads });
      } catch (error) {
        sendResponse(toResponseErrorPayload(error));
      }
      return;
    }

    if (message.type === "SAVE_CURRENT_NOTEPAD") {
      try {
        const result = await saveCurrentNotepadSelection(message.payload || {});
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse(toResponseErrorPayload(error));
      }
      return;
    }

    if (message.type === "SYNC_CURRENT_NOTEPAD") {
      try {
        const result = await syncCurrentNotepad();
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse(toResponseErrorPayload(error));
      }
      return;
    }

    if (message.type === "ADD_WORD_TO_CURRENT_NOTEPAD") {
      try {
        const result = await addWordToCurrentNotepad(message.payload && message.payload.word);
        sendResponse({
          ok: true,
          words: result.words,
          lastSync: result.lastSync,
          word: result.word,
          alreadyExists: result.alreadyExists,
          userMessage: result.alreadyExists
            ? `“${result.word}” 已经在当前云词本中了`
            : `已添加 “${result.word}” 到当前云词本`
        });
      } catch (error) {
        sendResponse(toResponseErrorPayload(error));
      }
      return;
    }

    if (message.type === "ADD_WORD_TO_HIGHLIGHT_BLACKLIST") {
      try {
        const result = await addWordToHighlightBlacklist(message.payload && message.payload.word);
        sendResponse({
          ok: true,
          word: result.word,
          alreadyExists: result.alreadyExists,
          userMessage: result.alreadyExists
            ? `“${result.word}” 已经在不标记名单中了`
            : `“${result.word}” 已加入不标记名单`
        });
      } catch (error) {
        sendResponse(toResponseErrorPayload(error));
      }
    }
  })();

  return true;
});
