const API_BASE = "https://open.maimemo.com/open/api/v1";

export function getMaimemoClient(settings) {
  const token = typeof settings === "string" ? settings : settings && settings.maimemoToken;
  return {
    base: API_BASE,
    headers: {
      Authorization: `Bearer ${String(token || "").trim()}`
    }
  };
}

export async function requestJSON(url, { method = "GET", headers, body } = {}) {
  const finalHeaders = {
    Accept: "application/json",
    "Accept-Language": "zh-CN,zh;q=0.9",
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...(headers || {})
  };

  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "omit"
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const code = data && data.errors && data.errors[0] && data.errors[0].code
      ? data.errors[0].code
      : `HTTP_${response.status}`;
    const msg = data && data.errors && data.errors[0] && data.errors[0].msg
      ? data.errors[0].msg
      : "";
    throw new Error(`${code}${msg ? `: ${msg}` : ""}`);
  }

  if (data && data.success === false) {
    const code = data.errors && data.errors[0] && data.errors[0].code
      ? data.errors[0].code
      : "UNKNOWN_ERROR";
    const msg = data.errors && data.errors[0] && data.errors[0].msg
      ? data.errors[0].msg
      : "";
    throw new Error(`${code}${msg ? `: ${msg}` : ""}`);
  }

  return data && typeof data === "object" && data.data !== undefined ? data.data : data;
}

export function normalizeWord(rawWord) {
  const normalized = String(rawWord || "")
    .trim()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ");

  if (!normalized) return "";
  if (!/^[A-Za-z]+(?:['-][A-Za-z]+)*(?: [A-Za-z]+(?:['-][A-Za-z]+)*)*$/.test(normalized)) {
    return "";
  }

  return normalized.toLowerCase();
}

export function extractWordsFromNotepad(notepad) {
  if (notepad && typeof notepad.content === "string") {
    const contentWords = notepad.content
      .split(/\r?\n/)
      .map(line => normalizeWord(line))
      .filter(Boolean);

    if (contentWords.length) {
      return Array.from(new Set(contentWords));
    }
  }

  const words = [];
  const parsedItems = notepad && Array.isArray(notepad.list) ? notepad.list : [];

  parsedItems.forEach((item) => {
    if (!item || item.type !== "WORD") return;
    const normalized = normalizeWord(item && item.data ? item.data.word : "");
    if (normalized) words.push(normalized);
  });

  return Array.from(new Set(words));
}

async function listAllNotepadsWithLimit(client, limit) {
  let offset = 0;
  const all = [];
  const seen = new Set();

  while (true) {
    let data;

    try {
      data = await requestJSON(
        `${client.base}/notepads?limit=${limit}&offset=${offset}`,
        { headers: client.headers }
      );
    } catch (error) {
      const message = String((error && error.message) || error || "");

      // Some accounts hit `common_invalid_param` once `offset` lands exactly at
      // the total count. If we have already collected pages, treat that as EOF.
      if (offset > 0 && all.length > 0 && message.startsWith("common_invalid_param")) {
        break;
      }

      throw error;
    }

    const notepads = Array.isArray(data && data.notepads) ? data.notepads : [];

    notepads.forEach((item) => {
      if (!item || !item.id) return;
      const id = String(item.id);
      if (seen.has(id)) return;
      seen.add(id);
      all.push({
        id,
        title: item.title ? String(item.title) : "",
        brief: item.brief ? String(item.brief) : "",
        status: item.status ? String(item.status) : "",
        type: item.type ? String(item.type) : "",
        updatedTime: item.updated_time ? String(item.updated_time) : "",
        tags: Array.isArray(item.tags) ? item.tags.map(String) : []
      });
    });

    if (notepads.length < limit) break;
    offset += notepads.length;
  }

  return all;
}

export async function listAllNotepads(client) {
  const pageSizes = [50, 20, 10, 5, 1];
  let lastError = null;

  for (const pageSize of pageSizes) {
    try {
      return await listAllNotepadsWithLimit(client, pageSize);
    } catch (error) {
      lastError = error;
      const message = String((error && error.message) || error || "");
      if (!message.startsWith("common_invalid_param")) throw error;
    }
  }

  throw lastError || new Error("LIST_NOTEPADS_FAILED");
}

export async function fetchNotepadDetail(client, notepadId) {
  const data = await requestJSON(
    `${client.base}/notepads/${encodeURIComponent(notepadId)}`,
    { headers: client.headers }
  );
  return data && data.notepad ? data.notepad : null;
}

export async function updateNotepad(client, notepadId, notepad) {
  const data = await requestJSON(
    `${client.base}/notepads/${encodeURIComponent(notepadId)}`,
    {
      method: "POST",
      headers: client.headers,
      body: { notepad }
    }
  );
  return data && data.notepad ? data.notepad : null;
}

export async function appendWordToNotepad(client, notepadId, rawWord) {
  const word = normalizeWord(rawWord);
  if (!word) throw new Error("INVALID_WORD");

  const current = await fetchNotepadDetail(client, notepadId);
  if (!current) throw new Error("NOTEPAD_NOT_FOUND");

  const currentWords = extractWordsFromNotepad(current);
  const hasWord = currentWords.some(item => item.toLowerCase() === word);

  if (hasWord) {
    return {
      word,
      alreadyExists: true,
      notepad: current,
      words: currentWords
    };
  }

  const nextContent = String(current.content || "").trimEnd();
  const mergedContent = nextContent ? `${nextContent}\n${word}` : word;
  const updated = await updateNotepad(client, notepadId, {
    status: current.status || "PUBLISHED",
    title: current.title || "",
    brief: current.brief || "",
    tags: Array.isArray(current.tags) ? current.tags : [],
    content: mergedContent
  });

  // Some update responses only return summary metadata instead of the full
  // notepad body. Rebuild the next cache from the pre-update detail plus the
  // appended content so we never collapse the local cache down to just the
  // newest term.
  const nextNotepadSnapshot = {
    ...(current || {}),
    ...(updated || {}),
    content: typeof (updated && updated.content) === "string" && updated.content.trim()
      ? updated.content
      : mergedContent
  };
  const nextWords = extractWordsFromNotepad(nextNotepadSnapshot);

  return {
    word,
    alreadyExists: false,
    notepad: nextNotepadSnapshot,
    words: Array.from(new Set(nextWords))
  };
}
