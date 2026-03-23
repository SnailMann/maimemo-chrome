import { DEFAULT_SETTINGS, STORAGE_KEYS, normalizeSettings } from "./shared.js";

const state = {
  settings: { ...DEFAULT_SETTINGS },
  words: [],
  lastSync: null,
  notepads: [],
  pendingNotepadId: "",
  pendingNotepadTitle: "",
  pendingNotepadMeta: ""
};

function $(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const element = $(id);
  if (element) element.textContent = text;
}

function setNotice(id, text, tone = "neutral") {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.dataset.tone = tone;
}

function request(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function explainError(code, detail = "") {
  if (code === "MISSING_TOKEN") return "请先填写并保存 Token。";
  if (code === "MISSING_CURRENT_NOTEPAD") return "请先选择一个云词本。";
  if (code === "INVALID_WORD") return "请先选中一个英文单词或词组。";
  if (code === "NOTEPAD_NOT_FOUND" || code === "common_not_found") {
    return "当前云词本不存在或已被删除，请重新获取云词本列表后再选择。";
  }
  if (code === "common_unauthorized") {
    return "Token 无效、已过期，或当前账号没有开放 API 权限，请重新保存 Token。";
  }
  if (code === "common_invalid_param") {
    return `墨墨接口拒绝了这次请求参数${detail ? `：${detail}` : ""}。插件已做兼容分页重试；如果仍失败，请重新获取云词本。`;
  }

  return "";
}

function formatResponseError(response, fallback) {
  const code = response && response.error ? String(response.error) : "UNKNOWN_ERROR";
  const detail = response && response.detail ? String(response.detail) : "";
  return explainError(code, detail) || `${fallback}：${code}${detail ? `（${detail}）` : ""}`;
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "未同步";
}

function getCurrentTokenInput() {
  return $("maimemoToken").value.trim();
}

function readTokenPayload() {
  return {
    maimemoToken: getCurrentTokenInput()
  };
}

function readSelectionPayload() {
  return {
    currentNotepadId: state.pendingNotepadId,
    currentNotepadTitle: state.pendingNotepadTitle,
    syncIntervalHours: $("syncIntervalHours").value.trim()
  };
}

function renderSummary() {
  setText("connectionStatus", state.settings.maimemoToken ? "已配置 Token" : "未配置");
  setText("currentNotepadSummary", state.settings.currentNotepadTitle || "未选择");
  setText("lastSyncSummary", formatTime(state.lastSync));
  setText("wordCountSummary", String(state.words.length));
}

function renderSelection() {
  setText("pendingNotepadTitle", state.pendingNotepadTitle || "还没有选择云词本");
  setText("pendingNotepadMeta", state.pendingNotepadMeta || "请先在上面的云词本列表中选中一个词本。");
  $("saveCurrentNotepad").disabled = !state.pendingNotepadId;
  $("syncNow").disabled = !state.settings.currentNotepadId;
}

function renderWords() {
  const keyword = ($("wordFilter").value || "").trim().toLowerCase();
  const filtered = keyword
    ? state.words.filter(word => String(word).toLowerCase().includes(keyword))
    : state.words.slice();

  const list = $("wordsList");
  list.textContent = "";

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.words.length ? "没有匹配到单词。" : "当前还没有同步到词表。";
    list.appendChild(empty);
  } else {
    filtered.forEach((word) => {
      const item = document.createElement("div");
      item.className = "word-item";
      item.textContent = word;
      list.appendChild(item);
    });
  }

  setNotice("wordsMeta", `缓存词数：${state.words.length}；当前显示：${filtered.length}`, "neutral");
}

function renderNotepads() {
  const keyword = ($("notepadFilter").value || "").trim().toLowerCase();
  const filtered = keyword
    ? state.notepads.filter((notepad) => {
        const title = String(notepad.title || "").toLowerCase();
        const tags = Array.isArray(notepad.tags) ? notepad.tags.join(" ").toLowerCase() : "";
        return title.includes(keyword) || tags.includes(keyword);
      })
    : state.notepads.slice();

  const list = $("notepadList");
  list.textContent = "";

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.notepads.length ? "没有匹配到词本。" : "还没有加载云词本列表。";
    list.appendChild(empty);
  } else {
    filtered.forEach((notepad) => {
      const item = document.createElement("div");
      item.className = `notepad-item${state.pendingNotepadId === notepad.id ? " is-selected" : ""}`;

      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "currentNotepad";
      radio.value = notepad.id;
      radio.checked = state.pendingNotepadId === notepad.id;
      radio.addEventListener("change", () => {
        state.pendingNotepadId = notepad.id;
        state.pendingNotepadTitle = notepad.title || notepad.id;
        state.pendingNotepadMeta = [
          notepad.brief ? `简介：${notepad.brief}` : "",
          Array.isArray(notepad.tags) && notepad.tags.length ? `标签：${notepad.tags.join("、")}` : "无标签"
        ].filter(Boolean).join("｜");
        renderNotepads();
        renderSelection();
        setNotice("selectionStatus", `已选中“${state.pendingNotepadTitle}”，点击“保存词本”即可更新本地缓存。`, "warning");
      });

      const content = document.createElement("div");
      const title = document.createElement("div");
      title.className = "notepad-title";
      title.textContent = notepad.title || notepad.id;

      const meta = document.createElement("div");
      meta.className = "notepad-meta";
      meta.textContent = [
        notepad.brief ? `简介：${notepad.brief}` : "",
        Array.isArray(notepad.tags) && notepad.tags.length ? `标签：${notepad.tags.join("、")}` : "无标签",
        notepad.updatedTime ? `更新：${new Date(notepad.updatedTime).toLocaleDateString()}` : ""
      ].filter(Boolean).join("｜");

      content.appendChild(title);
      content.appendChild(meta);
      label.appendChild(radio);
      label.appendChild(content);
      item.appendChild(label);
      list.appendChild(item);
    });
  }
}

function renderAll() {
  $("maimemoToken").value = state.settings.maimemoToken || "";
  $("syncIntervalHours").value = String(state.settings.syncIntervalHours || DEFAULT_SETTINGS.syncIntervalHours);
  renderSummary();
  renderSelection();
  renderWords();
  renderNotepads();
}

async function loadOptionsState() {
  const response = await request("GET_OPTIONS_STATE");
  if (!response || !response.ok) throw new Error("LOAD_OPTIONS_STATE_FAILED");

  state.settings = normalizeSettings(response.settings || DEFAULT_SETTINGS);
  state.words = Array.isArray(response.words) ? response.words.map(String) : [];
  state.lastSync = response.lastSync || null;
  state.pendingNotepadId = state.settings.currentNotepadId || "";
  state.pendingNotepadTitle = state.settings.currentNotepadTitle || "";
  state.pendingNotepadMeta = state.settings.currentNotepadTitle
    ? "这是当前已经保存的待同步云词本，会按下面设置的周期同步到本地缓存。"
    : "";
  renderAll();
}

async function refreshNotepads({ auto = false } = {}) {
  const token = getCurrentTokenInput() || state.settings.maimemoToken;
  if (!token) {
    setNotice("notepadStatus", "请先填写并保存 Token，再读取云词本列表。", "warning");
    return { ok: false, error: "MISSING_TOKEN" };
  }

  setNotice("notepadStatus", auto ? "正在自动读取云词本列表..." : "正在读取云词本列表...", "neutral");
  const response = await request("LIST_NOTEPADS", { maimemoToken: token });

  if (!response || !response.ok) {
    setNotice("notepadStatus", formatResponseError(response, "读取云词本失败"), "error");
    return { ok: false, error: response && response.error ? response.error : "UNKNOWN_ERROR" };
  }

  state.notepads = Array.isArray(response.notepads) ? response.notepads : [];
  const current = state.notepads.find(item => item.id === (state.pendingNotepadId || state.settings.currentNotepadId));

  if (current) {
    state.pendingNotepadId = current.id;
    state.pendingNotepadTitle = current.title || current.id;
    state.pendingNotepadMeta = [
      current.brief ? `简介：${current.brief}` : "",
      Array.isArray(current.tags) && current.tags.length ? `标签：${current.tags.join("、")}` : "无标签"
    ].filter(Boolean).join("｜");
  } else {
    state.pendingNotepadId = "";
    state.pendingNotepadTitle = "";
    state.pendingNotepadMeta = "";
    setNotice(
      "selectionStatus",
      state.settings.currentNotepadId
        ? "之前保存的云词本已不在当前列表中，请重新选择一个待同步词本。"
        : "云词本列表已读取，请选择一个待同步词本。",
      "warning"
    );
  }

  renderNotepads();
  renderSelection();
  renderSummary();
  setNotice(
    "notepadStatus",
    state.notepads.length
      ? `已读取 ${state.notepads.length} 个云词本，请选择一个作为当前待同步词本。`
      : "读取成功，但当前账号下还没有可用云词本。",
    state.notepads.length ? "success" : "warning"
  );
  return { ok: true, count: state.notepads.length };
}

async function saveToken() {
  const payload = readTokenPayload();
  if (!payload.maimemoToken) {
    setNotice("tokenStatus", "请先填写 Token。", "warning");
    return;
  }

  setNotice("tokenStatus", "正在保存 Token...", "neutral");
  const response = await request("SAVE_TOKEN", payload);

  if (!response || !response.ok) {
    setNotice("tokenStatus", formatResponseError(response, "保存 Token 失败"), "error");
    return;
  }

  state.settings = normalizeSettings(response.settings || state.settings);
  renderAll();
  setNotice("tokenStatus", "Token 已保存，正在继续获取云词本列表。", "success");
  const refreshResult = await refreshNotepads({ auto: true });

  if (!refreshResult || !refreshResult.ok) {
    setNotice("tokenStatus", "Token 已保存，但自动读取云词本失败，请检查 Token 是否可用。", "warning");
    return;
  }

  setNotice("tokenStatus", "Token 已保存，可以继续选择云词本。", "success");
}

async function saveCurrentNotepad() {
  if (!state.pendingNotepadId) {
    setNotice("selectionStatus", "请先选择一个云词本。", "warning");
    return;
  }

  setNotice("selectionStatus", "正在保存词本并同步...", "neutral");
  const response = await request("SAVE_CURRENT_NOTEPAD", readSelectionPayload());

  if (!response || !response.ok) {
    setNotice("selectionStatus", formatResponseError(response, "保存当前词本失败"), "error");
    return;
  }

  const sync = response.sync || {};
  state.settings = normalizeSettings(response.settings || sync.settings || state.settings);
  state.pendingNotepadId = state.settings.currentNotepadId || state.pendingNotepadId;
  state.pendingNotepadTitle = state.settings.currentNotepadTitle || state.pendingNotepadTitle;

  if (sync && Array.isArray(sync.words)) {
    state.words = sync.words.map(String);
    state.lastSync = sync.lastSync || state.lastSync;
    state.pendingNotepadMeta = `已保存为当前待同步云词本，会按每 ${state.settings.syncIntervalHours} 小时自动同步到本地缓存。`;
    renderAll();
    setNotice("selectionStatus", `已保存“${state.settings.currentNotepadTitle}”，并同步 ${state.words.length} 个单词到本地缓存。`, "success");
    return;
  }

  state.pendingNotepadMeta = `当前词本已经保存，后续会按每 ${state.settings.syncIntervalHours} 小时尝试同步到本地缓存，但这次全量同步没有成功。`;
  renderAll();
  setNotice(
    "selectionStatus",
    `已保存“${state.settings.currentNotepadTitle}”，但全量同步失败。${formatResponseError(response.syncError || {}, "同步失败")}`,
    "warning"
  );
}

async function syncCurrentNotepad() {
  setNotice("selectionStatus", "正在同步当前词本...", "neutral");
  const response = await request("SYNC_CURRENT_NOTEPAD");

  if (!response || !response.ok) {
    setNotice("selectionStatus", formatResponseError(response, "同步失败"), "error");
    return;
  }

  state.settings = normalizeSettings(response.settings || state.settings);
  state.words = Array.isArray(response.words) ? response.words.map(String) : [];
  state.lastSync = response.lastSync || null;
  state.pendingNotepadId = state.settings.currentNotepadId || state.pendingNotepadId;
  state.pendingNotepadTitle = state.settings.currentNotepadTitle || state.pendingNotepadTitle;
  state.pendingNotepadMeta = `这是当前已经保存的待同步云词本，会按每 ${state.settings.syncIntervalHours} 小时同步到本地缓存。`;
  renderAll();
  setNotice("selectionStatus", `同步完成，当前缓存 ${state.words.length} 个单词。`, "success");
}

async function copyWords() {
  const keyword = ($("wordFilter").value || "").trim().toLowerCase();
  const filtered = keyword
    ? state.words.filter(word => String(word).toLowerCase().includes(keyword))
    : state.words.slice();
  await navigator.clipboard.writeText(filtered.join("\n"));
  setNotice("wordsMeta", `已复制 ${filtered.length} 个单词到剪贴板。`, "success");
}

function bindEvents() {
  $("saveToken").addEventListener("click", saveToken);
  $("refreshNotepads").addEventListener("click", () => refreshNotepads());
  $("saveCurrentNotepad").addEventListener("click", saveCurrentNotepad);
  $("syncNow").addEventListener("click", syncCurrentNotepad);
  $("notepadFilter").addEventListener("input", renderNotepads);
  $("wordFilter").addEventListener("input", renderWords);
  $("copyWords").addEventListener("click", copyWords);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes[STORAGE_KEYS.words]) {
      state.words = Array.isArray(changes[STORAGE_KEYS.words].newValue)
        ? changes[STORAGE_KEYS.words].newValue.map(String)
        : [];
    }

    if (changes[STORAGE_KEYS.lastSync]) {
      state.lastSync = changes[STORAGE_KEYS.lastSync].newValue || null;
    }

    if (changes[STORAGE_KEYS.settings]) {
      state.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue || DEFAULT_SETTINGS);
      $("maimemoToken").value = state.settings.maimemoToken || "";
      $("syncIntervalHours").value = String(state.settings.syncIntervalHours || DEFAULT_SETTINGS.syncIntervalHours);
      if (state.settings.currentNotepadId) {
        state.pendingNotepadId = state.settings.currentNotepadId;
        state.pendingNotepadTitle = state.settings.currentNotepadTitle;
      } else {
        state.pendingNotepadId = "";
        state.pendingNotepadTitle = "";
      }
    }

    renderSummary();
    renderSelection();
    renderWords();
    renderNotepads();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadOptionsState();
  setNotice("tokenStatus", state.settings.maimemoToken ? "已检测到已保存的 Token。" : "还没有保存 Token。", state.settings.maimemoToken ? "success" : "warning");
  setNotice("notepadStatus", "还没有读取云词本列表。", "neutral");
  setNotice(
    "selectionStatus",
    state.settings.currentNotepadId
      ? `当前已保存一个待同步云词本，会按每 ${state.settings.syncIntervalHours} 小时同步到本地缓存。`
      : "等待你选择一个待同步的云词本。",
    state.settings.currentNotepadId ? "success" : "warning"
  );
  if (state.settings.maimemoToken) {
    await refreshNotepads({ auto: true });
  }
});
