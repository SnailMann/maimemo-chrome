const STORAGE_KEYS = {
  words: "maimemo_words",
  blacklist: "maimemo_highlight_blacklist"
};

const HIGHLIGHT_CLASS = "maimemo-highlight";
const ACTIONS_CLASS = "maimemo-selection-actions";
const ACTIONS_BUTTON_CLASS = "maimemo-selection-button";
const TOAST_CONTAINER_CLASS = "maimemo-toast-container";
const TOAST_CLASS = "maimemo-toast";
const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "textarea",
  "input",
  "select",
  "option",
  "code",
  "pre",
  "svg",
  "math"
]);
const WORD_PATTERN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const HAS_LETTER_PATTERN = /[A-Za-z]/;

let currentStoredWordSet = new Set();
let currentBlacklistSet = new Set();
let currentWordSet = new Set();
let optimisticWordSet = new Set();
let isRendering = false;
let observer = null;
let toastTimer = null;
const pendingRoots = new Set();
const pendingActionKeys = new Set();
let flushTimer = null;
let fullRenderTimer = null;
let selectionActions = null;

function normalizeWord(rawWord) {
  return String(rawWord || "")
    .trim()
    .replace(/[’]/g, "'")
    .toLowerCase();
}

function toNormalizedSet(words) {
  return new Set(
    (Array.isArray(words) ? words : [])
      .map(normalizeWord)
      .filter(Boolean)
  );
}

function recomputeHighlightWordSet() {
  const mergedWordSet = new Set(currentStoredWordSet);
  optimisticWordSet.forEach((word) => mergedWordSet.add(word));
  currentWordSet = new Set(
    Array.from(mergedWordSet).filter(word => !currentBlacklistSet.has(word))
  );
}

function setStoredWords(words) {
  currentStoredWordSet = toNormalizedSet(words);
  recomputeHighlightWordSet();
}

function setHighlightBlacklist(words) {
  currentBlacklistSet = toNormalizedSet(words);
  recomputeHighlightWordSet();
}

function syncOptimisticWords() {
  let changed = false;

  optimisticWordSet.forEach((word) => {
    if (!currentStoredWordSet.has(word)) return;
    optimisticWordSet.delete(word);
    changed = true;
  });

  if (changed) {
    recomputeHighlightWordSet();
  }
}

function throttle(fn, wait) {
  let lastRun = 0;
  let timer = null;

  return function throttled(...args) {
    const now = Date.now();
    const invoke = () => {
      lastRun = Date.now();
      timer = null;
      fn.apply(this, args);
    };

    if (now - lastRun >= wait) {
      invoke();
      return;
    }

    if (!timer) {
      timer = setTimeout(invoke, wait - (now - lastRun));
    }
  };
}

function shouldSkipElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
  if (element.closest(`.${TOAST_CONTAINER_CLASS}`)) return true;
  if (element.closest(`.${HIGHLIGHT_CLASS}`)) return true;
  if (element.isContentEditable) return true;
  return SKIP_TAGS.has(element.tagName.toLowerCase());
}

function shouldProcessTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  if (!node.nodeValue || !node.nodeValue.trim()) return false;
  if (!HAS_LETTER_PATTERN.test(node.nodeValue)) return false;
  const parent = node.parentElement;
  return !!parent && !shouldSkipElement(parent);
}

function unwrap(node) {
  if (!node || !node.parentNode) return;
  const fragment = document.createDocumentFragment();
  while (node.firstChild) fragment.appendChild(node.firstChild);
  node.parentNode.replaceChild(fragment, node);
}

function clearHighlights() {
  document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`).forEach(unwrap);
}

function buildHighlightFragment(text) {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let matched = false;
  let match;

  WORD_PATTERN.lastIndex = 0;

  while ((match = WORD_PATTERN.exec(text))) {
    const word = match[0];
    if (!currentWordSet.has(normalizeWord(word))) continue;

    matched = true;

    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const mark = document.createElement("mark");
    mark.className = HIGHLIGHT_CLASS;
    mark.textContent = word;
    fragment.appendChild(mark);

    lastIndex = match.index + word.length;
  }

  if (!matched) return null;

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function highlightTextNode(node) {
  if (!shouldProcessTextNode(node) || !node.parentNode) return;
  const fragment = buildHighlightFragment(node.nodeValue);
  if (!fragment) return;
  node.parentNode.replaceChild(fragment, node);
}

function collectTextNodes(root) {
  if (!root) return [];

  if (root.nodeType === Node.TEXT_NODE) {
    return shouldProcessTextNode(root) ? [root] : [];
  }

  if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body && root !== document.documentElement) {
    return [];
  }

  const elementRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
  if (!elementRoot || shouldSkipElement(elementRoot)) return [];

  const walker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldProcessTextNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    }
  });

  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  return nodes;
}

function connectObserver() {
  if (!observer || !document.documentElement || !currentWordSet.size) return;
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function disconnectObserver() {
  if (observer) observer.disconnect();
}

function withObserverPaused(fn) {
  disconnectObserver();
  try {
    return fn();
  } finally {
    connectObserver();
  }
}

function processRoots(roots, { clear = false } = {}) {
  if (!document.body) return;

  isRendering = true;

  withObserverPaused(() => {
    if (clear) clearHighlights();
    if (!currentWordSet.size) return;

    roots.forEach((root) => {
      collectTextNodes(root).forEach(highlightTextNode);
    });
  });

  isRendering = false;
}

function renderHighlights() {
  processRoots([document.body], { clear: true });
}

function scheduleIdle(callback, delay = 0) {
  if (typeof window.requestIdleCallback === "function") {
    return window.requestIdleCallback(callback, { timeout: Math.max(300, delay || 0) });
  }

  return window.setTimeout(callback, delay);
}

function cancelIdle(handle) {
  if (!handle) return;

  if (typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle);
    return;
  }

  clearTimeout(handle);
}

function addPendingRoot(root) {
  if (!root) return;
  const target = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
  if (!target || !target.isConnected) return;
  if (target.nodeType === Node.ELEMENT_NODE && shouldSkipElement(target)) return;

  for (const existing of pendingRoots) {
    if (existing === target) return;
    if (existing.contains && existing.contains(target)) return;
    if (target.contains && target.contains(existing)) pendingRoots.delete(existing);
  }

  pendingRoots.add(target);

  if (pendingRoots.size > 24) {
    pendingRoots.clear();
    scheduleFullRender();
    return;
  }

  schedulePendingRoots();
}

const flushPendingRoots = throttle(() => {
  if (isRendering || !currentWordSet.size || !pendingRoots.size) return;

  const roots = Array.from(pendingRoots).filter(root => root && root.isConnected);
  pendingRoots.clear();
  processRoots(roots);
}, 300);

const rerenderAllHighlights = throttle(() => {
  if (isRendering) return;
  renderHighlights();
}, 500);

function schedulePendingRoots() {
  if (flushTimer) return;

  flushTimer = scheduleIdle(() => {
    flushTimer = null;
    flushPendingRoots();
  }, 300);
}

function scheduleFullRender() {
  if (fullRenderTimer) return;

  fullRenderTimer = scheduleIdle(() => {
    fullRenderTimer = null;
    rerenderAllHighlights();
  }, 500);
}

function normalizeSelectedWord(rawWord) {
  const matches = String(rawWord || "")
    .trim()
    .replace(/[’]/g, "'")
    .match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g);

  if (!matches || matches.length !== 1) return "";
  return matches[0].toLowerCase();
}

function getCurrentSelectionWord() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return "";
  return normalizeSelectedWord(selection.toString());
}

function getSelectionRect() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect && (rect.width || rect.height)) {
    return rect;
  }

  const rects = range.getClientRects();
  return rects && rects.length ? rects[0] : null;
}

function getSelectionHighlightRoot() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return document.body;

  const container = selection.getRangeAt(0).commonAncestorContainer;
  if (!container) return document.body;
  return container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
}

function getSelectionActions() {
  if (selectionActions) return selectionActions;

  const container = document.createElement("div");
  container.className = ACTIONS_CLASS;
  container.hidden = true;

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = `${ACTIONS_BUTTON_CLASS} ${ACTIONS_BUTTON_CLASS}--primary`;
  addButton.dataset.action = "add";
  addButton.textContent = "添加单词";

  const muteButton = document.createElement("button");
  muteButton.type = "button";
  muteButton.className = ACTIONS_BUTTON_CLASS;
  muteButton.dataset.action = "blacklist";
  muteButton.textContent = "不再标记";

  container.appendChild(addButton);
  container.appendChild(muteButton);
  document.documentElement.appendChild(container);
  selectionActions = container;
  return container;
}

function hideSelectionActions() {
  const container = getSelectionActions();
  container.hidden = true;
  delete container.dataset.word;
}

function positionSelectionActions(rect) {
  const container = getSelectionActions();
  container.hidden = false;
  container.style.left = "12px";
  container.style.top = "12px";

  const width = Math.max(container.offsetWidth, 220);
  const height = Math.max(container.offsetHeight, 44);
  const left = Math.min(
    Math.max(12, rect.left + (rect.width / 2) - (width / 2)),
    window.innerWidth - width - 12
  );

  let top = rect.bottom + 10;
  if (top + height > window.innerHeight - 12) {
    top = Math.max(12, rect.top - height - 10);
  }

  container.style.left = `${Math.round(left)}px`;
  container.style.top = `${Math.round(top)}px`;
}

function showSelectionActions(word, rect) {
  if (!word || !rect) {
    hideSelectionActions();
    return;
  }

  const container = getSelectionActions();
  container.dataset.word = word;

  const muteButton = container.querySelector('[data-action="blacklist"]');
  if (muteButton) {
    muteButton.textContent = currentBlacklistSet.has(word) ? "已不标记" : "不再标记";
  }

  positionSelectionActions(rect);
}

function getPendingActionKey(type, word) {
  return `${type}:${word}`;
}

function getPendingActionMessage(type, word) {
  if (type === "ADD_WORD_TO_CURRENT_NOTEPAD") {
    return `正在添加 “${word}”...`;
  }

  if (type === "ADD_WORD_TO_HIGHLIGHT_BLACKLIST") {
    return `正在设置 “${word}” 为不标记...`;
  }

  return "正在处理...";
}

function addOptimisticWord(word, root) {
  if (!word || currentStoredWordSet.has(word) || optimisticWordSet.has(word)) {
    return;
  }

  optimisticWordSet.add(word);
  recomputeHighlightWordSet();
  addPendingRoot(root || document.body);
}

function removeOptimisticWord(word, { rerender = false } = {}) {
  if (!optimisticWordSet.delete(word)) return;
  recomputeHighlightWordSet();
  if (rerender) {
    scheduleFullRender();
  }
}

function sendActionMessage(type, word) {
  const key = getPendingActionKey(type, word);
  const optimisticRoot = type === "ADD_WORD_TO_CURRENT_NOTEPAD"
    ? getSelectionHighlightRoot()
    : null;

  if (type === "ADD_WORD_TO_CURRENT_NOTEPAD") {
    addOptimisticWord(word, optimisticRoot);
  }

  hideSelectionActions();

  if (pendingActionKeys.has(key)) {
    showToast("这条操作正在处理中，请稍候。", "info");
    return;
  }

  pendingActionKeys.add(key);
  showToast(getPendingActionMessage(type, word), "info");

  chrome.runtime.sendMessage({
    type,
    payload: { word }
  }).then((response) => {
    if (!response || !response.ok) {
      if (type === "ADD_WORD_TO_CURRENT_NOTEPAD") {
        removeOptimisticWord(word, { rerender: true });
      }
      showToast(
        response && response.userMessage
          ? response.userMessage
          : "操作失败，请稍后再试。",
        "error"
      );
      return;
    }

    showToast(response.userMessage || "操作成功。", response.alreadyExists ? "info" : "success");
  }).catch(() => {
    if (type === "ADD_WORD_TO_CURRENT_NOTEPAD") {
      removeOptimisticWord(word, { rerender: true });
    }
    showToast("操作失败，请稍后再试。", "error");
  }).finally(() => {
    pendingActionKeys.delete(key);
  });
}

function getToastContainer() {
  let container = document.querySelector(`.${TOAST_CONTAINER_CLASS}`);
  if (container) return container;

  container = document.createElement("div");
  container.className = TOAST_CONTAINER_CLASS;
  document.documentElement.appendChild(container);
  return container;
}

function showToast(message, tone = "info") {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `${TOAST_CLASS} ${TOAST_CLASS}--${tone}`;
  toast.textContent = message;
  container.textContent = "";
  container.appendChild(toast);

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 2200);
}

async function loadWordsFromStorage() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.words,
    STORAGE_KEYS.blacklist
  ]);
  setStoredWords(stored[STORAGE_KEYS.words]);
  setHighlightBlacklist(stored[STORAGE_KEYS.blacklist]);
}

function initObserver() {
  observer = new MutationObserver((mutations) => {
    if (isRendering || !currentWordSet.size) return;

    mutations.forEach((mutation) => {
      if (mutation.type !== "childList") return;
      mutation.addedNodes.forEach(addPendingRoot);
    });
  });

  if (currentWordSet.size) connectObserver();
}

function handleDoubleClick(event) {
  window.setTimeout(() => {
    const word = getCurrentSelectionWord();
    if (!word) {
      hideSelectionActions();
      return;
    }

    const rect = getSelectionRect() || {
      left: event.clientX,
      top: event.clientY,
      bottom: event.clientY,
      width: 0,
      height: 0
    };

    showSelectionActions(word, rect);
  }, 0);
}

function handlePointerDown(event) {
  const container = selectionActions;
  if (!container || container.hidden) return;
  if (container.contains(event.target)) return;
  hideSelectionActions();
}

function bindSelectionActions() {
  const container = getSelectionActions();

  container.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    const word = container.dataset.word || "";
    if (!word) {
      hideSelectionActions();
      return;
    }

    if (button.dataset.action === "add") {
      sendActionMessage("ADD_WORD_TO_CURRENT_NOTEPAD", word);
      return;
    }

    if (button.dataset.action === "blacklist") {
      sendActionMessage("ADD_WORD_TO_HIGHLIGHT_BLACKLIST", word);
    }
  });

  document.addEventListener("dblclick", handleDoubleClick, true);
  document.addEventListener("mousedown", handlePointerDown, true);
  window.addEventListener("scroll", hideSelectionActions, true);
  window.addEventListener("blur", hideSelectionActions);
}

async function init() {
  await loadWordsFromStorage();
  renderHighlights();
  initObserver();
  bindSelectionActions();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    const hasWordsChange = !!changes[STORAGE_KEYS.words];
    const hasBlacklistChange = !!changes[STORAGE_KEYS.blacklist];
    if (!hasWordsChange && !hasBlacklistChange) return;

    const previous = new Set(currentWordSet);

    if (hasWordsChange) {
      setStoredWords(changes[STORAGE_KEYS.words].newValue);
      syncOptimisticWords();
    }

    if (hasBlacklistChange) {
      setHighlightBlacklist(changes[STORAGE_KEYS.blacklist].newValue);
    }

    const nextSet = new Set(currentWordSet);

    const addedWords = [];
    let removedCount = 0;

    nextSet.forEach((word) => {
      if (!previous.has(word)) addedWords.push(word);
    });

    previous.forEach((word) => {
      if (!nextSet.has(word)) removedCount += 1;
    });

    if (!removedCount && addedWords.length === 0) {
      connectObserver();
      return;
    }

    if (!currentWordSet.size) {
      disconnectObserver();
      pendingRoots.clear();
      cancelIdle(flushTimer);
      cancelIdle(fullRenderTimer);
      flushTimer = null;
      fullRenderTimer = null;
      rerenderAllHighlights();
      return;
    }

    connectObserver();

    if (!previous.size) {
      scheduleFullRender();
      return;
    }

    if (!removedCount && addedWords.length > 0 && addedWords.length <= 8) {
      addPendingRoot(document.body);
      return;
    }

    scheduleFullRender();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "SHOW_TOAST") {
      const payload = message.payload || {};
      showToast(String(payload.message || ""), String(payload.tone || "info"));
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
}

init().catch(() => {});
