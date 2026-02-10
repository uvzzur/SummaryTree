/**
 * SummaryTree background (service worker).
 * Context menu, selection validation, LRU cache, LLM calls (HF/OpenAI), messaging to content script.
 */
const MENU_ID = "TRACEABLE_SUMMARY";

/* Cache */
const CACHE_INDEX_KEY = "cacheIndex";
const CACHE_PREFIX = "cache:";
const CACHE_MAX_ITEMS = 30;

/* Limits */
const MIN_CHARS = 200;
const MAX_CHARS = 15000;

/* Provider keys */
const STORE_PROVIDER = "llmProvider";      // "hf" | "openai" | "auto"
const STORE_HF_TOKEN = "hfApiToken";
const STORE_OPENAI_KEY = "openaiApiKey";

/* OpenAI */
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4.1-mini";

/* HF Router (OpenAI-compatible) */
const HF_URL = "https://router.huggingface.co/v1/chat/completions";
const HF_MODEL = "HuggingFaceTB/SmolLM3-3B:hf-inference";

/* Generation */
const TEMPERATURE = 0;
const MAX_OUTPUT_TOKENS = 900;

/* Menu */
function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Traceable summary (from selection)",
      contexts: ["selection"]
    });
  });
}
chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);
createMenu();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});

/* Hash */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function makeCacheKey(url, selectionText) {
  return fnv1a32(`${url}\n${selectionText}`);
}

/* Storage */
async function getCacheEntry(cacheKey) {
  const obj = await chrome.storage.local.get([CACHE_PREFIX + cacheKey]);
  return obj[CACHE_PREFIX + cacheKey] || null;
}

async function touchCacheIndex(cacheKey) {
  const { cacheIndex } = await chrome.storage.local.get([CACHE_INDEX_KEY]);
  let idx = Array.isArray(cacheIndex) ? cacheIndex : [];

  idx = idx.filter((k) => k !== cacheKey);
  idx.unshift(cacheKey);

  const toRemove = idx.slice(CACHE_MAX_ITEMS);
  idx = idx.slice(0, CACHE_MAX_ITEMS);

  await chrome.storage.local.set({ [CACHE_INDEX_KEY]: idx });
  if (toRemove.length) {
    await chrome.storage.local.remove(toRemove.map((k) => CACHE_PREFIX + k));
  }
}

async function setCacheEntry(cacheKey, entry) {
  await chrome.storage.local.set({ [CACHE_PREFIX + cacheKey]: entry });
  await touchCacheIndex(cacheKey);
}

async function loadProviderConfig() {
  const obj = await chrome.storage.local.get([STORE_PROVIDER, STORE_HF_TOKEN, STORE_OPENAI_KEY]);
  return {
    provider: obj[STORE_PROVIDER] || "auto",
    hfToken: (obj[STORE_HF_TOKEN] || "").trim(),
    openaiKey: (obj[STORE_OPENAI_KEY] || "").trim()
  };
}

function pickProvider(cfg) {
  if (cfg.provider === "hf") return "hf";
  if (cfg.provider === "openai") return "openai";
  if (cfg.hfToken) return "hf";
  if (cfg.openaiKey) return "openai";
  return "none";
}

/* Prompt: title + L1 = short summary, L2 = regular summary, L3 = verbatim citation only */
function buildSystemPrompt() {
  return [
    "You are given a block of text selected from a webpage.",
    "Create a traceable summary with a short title, 2 summary levels per point, and verbatim source excerpts.",
    "",
    "Hard rules:",
    "- Output MUST be valid JSON only. No markdown. No extra text.",
    "- Include a \"title\" field: one short phrase (e.g. 5–12 words) that describes the whole selection.",
    "- Each item must include a verbatim, contiguous excerpt copied from the input text.",
    "- If you cannot provide a verbatim excerpt for an item, omit the item.",
    "- level1: SHORT summary of that point — one short sentence.",
    "- level2: REGULAR summary — 2–3 sentences, still summarized.",
    "- source_excerpt: Exact copy of 1–3 sentences from the input. Verbatim only.",
    "",
    "Output schema:",
    '{ "title": "Short phrase for the whole selection", "items": [ { "id": "1", "level1": "...", "level2": "...", "source_excerpt": "..." } ] }',
    "",
    "Return 3 to 6 items max."
  ].join("\n");
}

/* Robust JSON extraction */
function extractJson(text) {
  if (!text) throw new Error("Empty model response");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(text.slice(start, end + 1));
}

/* Validate excerpts exist */
function normalizeSpace(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** True if excerpt appears in selection (exact or any of several anchor/chunk checks). */
function excerptFoundInSelection(hay, ex) {
  if (!ex || ex.length < 20) return false;
  if (hay.includes(ex)) return true;
  const len = ex.length;
  if (len < 40) return false;
  const anchors = [
    [0, 50], [0, 40], [0, 30],
    [len - 50, len], [len - 40, len], [len - 30, len]
  ].filter(([a, b]) => b - a >= 25);
  for (const [start, end] of anchors) {
    const chunk = ex.slice(start, end);
    if (chunk.length >= 25 && hay.includes(chunk)) return true;
  }
  const mid = Math.floor(len / 2);
  if (hay.includes(ex.slice(Math.max(0, mid - 35), mid + 35))) return true;
  return false;
}

function filterBadExcerpts(summary, selectionText) {
  if (!summary || !Array.isArray(summary.items)) return { title: "", items: [] };

  const title = String(summary.title || "").trim();
  const hay = normalizeSpace(selectionText);
  const kept = [];

  for (const it of summary.items) {
    const l1 = String(it?.level1 || "").trim();
    const l2 = String(it?.level2 || "").trim();
    const exRaw = String(it?.source_excerpt || "");
    const ex = normalizeSpace(exRaw);

    if (!l1 || !ex) continue;
    if (ex.length < 20) continue;
    if (!excerptFoundInSelection(hay, ex)) continue;
    /* Skip items where L2 and excerpt are identical (no real citation). */
    if (normalizeSpace(l2) === ex) continue;

    kept.push({
      id: String(it.id || kept.length + 1),
      level1: l1,
      level2: l2,
      source_excerpt: exRaw
    });
  }

  return { title: title || "Summary", items: kept.slice(0, 6) };
}

/* Call OpenAI-style chat completions (OpenAI + HF router) */
async function callChatCompletions({ url, apiKey, model, systemPrompt, userText }) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ]
    })
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${raw}`);

  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Missing choices[0].message.content");
  return content;
}

async function generateSummary(selectionText, cfg) {
  const provider = pickProvider(cfg);
  if (provider === "none") {
    throw new Error("Missing keys. Open Settings and add a Hugging Face token or an OpenAI API key.");
  }

  const systemPrompt = buildSystemPrompt();

  const attempts = [];
  if (provider === "hf") {
    attempts.push({ kind: "hf" });
    if (cfg.openaiKey) attempts.push({ kind: "openai" });
  } else {
    attempts.push({ kind: "openai" });
    if (cfg.hfToken) attempts.push({ kind: "hf" });
  }

  let lastErr = null;

  for (const a of attempts) {
    try {
      const content =
        a.kind === "hf"
          ? await callChatCompletions({
              url: HF_URL,
              apiKey: cfg.hfToken,
              model: HF_MODEL,
              systemPrompt,
              userText: selectionText
            })
          : await callChatCompletions({
              url: OPENAI_URL,
              apiKey: cfg.openaiKey,
              model: OPENAI_MODEL,
              systemPrompt,
              userText: selectionText
            });

      let parsed;
      try {
        parsed = extractJson(content);
      } catch {
        const retryContent =
          a.kind === "hf"
            ? await callChatCompletions({
                url: HF_URL,
                apiKey: cfg.hfToken,
                model: HF_MODEL,
                systemPrompt,
                userText: selectionText + "\n\nIMPORTANT: Return ONLY valid JSON matching the schema. No extra text."
              })
            : await callChatCompletions({
                url: OPENAI_URL,
                apiKey: cfg.openaiKey,
                model: OPENAI_MODEL,
                systemPrompt,
                userText: selectionText + "\n\nIMPORTANT: Return ONLY valid JSON matching the schema. No extra text."
              });

        parsed = extractJson(retryContent);
      }

      const filtered = filterBadExcerpts(parsed, selectionText);
      if (!filtered.items.length) {
        throw new Error("No valid traceable items produced (excerpts didn't match selection).");
      }

      return { summary: filtered, usedProvider: a.kind };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Unknown error");
}

/* Send panel messages (ignore failures on chrome:// pages etc.) */
async function safeSendToTab(tabId, message) {
  try {
    if (!tabId) return;
    await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // content script may not exist on some pages; ignore
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;

  try {
    if (info.menuItemId !== MENU_ID) return;

    const selectedText = (info.selectionText || "").trim();
    const url = tab?.url || "";

    // Limits -> also show in panel
    if (selectedText.length < MIN_CHARS) {
      const summary = {
        items: [{
          id: "1",
          level1: "Selection too short.",
          level2: `Select at least ${MIN_CHARS} characters.`,
          source_excerpt: ""
        }]
      };

      await chrome.storage.local.set({
        lastSelection: selectedText,
        lastStatus: "done",
        lastStatusText: "",
        lastSummary: summary,
        lastUpdatedAt: Date.now(),
        lastCacheHit: false,
        lastProviderUsed: ""
      });

      await safeSendToTab(tabId, { type: "SHOW_PANEL", summary, statusText: "Selection too short." });
      return;
    }

    if (selectedText.length > MAX_CHARS) {
      const summary = {
        items: [{
          id: "1",
          level1: "Selection too long.",
          level2: `Please select less than ${MAX_CHARS} characters.`,
          source_excerpt: ""
        }]
      };

      await chrome.storage.local.set({
        lastSelection: selectedText.slice(0, MAX_CHARS),
        lastStatus: "done",
        lastStatusText: "",
        lastSummary: summary,
        lastUpdatedAt: Date.now(),
        lastCacheHit: false,
        lastProviderUsed: ""
      });

      await safeSendToTab(tabId, { type: "SHOW_PANEL", summary, statusText: "Selection too long." });
      return;
    }

    // Loader state for panel
    await chrome.storage.local.set({
      lastSelection: selectedText,
      lastStatus: "loading",
      lastStatusText: "Generating summary…",
      lastUpdatedAt: Date.now()
    });

    await safeSendToTab(tabId, { type: "PANEL_STATUS", status: "loading", text: "Generating summary…" });

    const cfg = await loadProviderConfig();

    // Cache
    const cacheKey = makeCacheKey(url, selectedText);
    const cached = await getCacheEntry(cacheKey);
    if (cached?.summary) {
      await chrome.storage.local.set({
        lastSelection: selectedText,
        lastStatus: "done",
        lastStatusText: "",
        lastSummary: cached.summary,
        lastUpdatedAt: Date.now(),
        lastCacheHit: true,
        lastProviderUsed: cached.usedProvider || "cache"
      });

      await touchCacheIndex(cacheKey);

      await safeSendToTab(tabId, {
        type: "SHOW_PANEL",
        summary: cached.summary,
        statusText: "Cached result. Click an item to expand."
      });
      return;
    }

    // Generate
    const { summary, usedProvider } = await generateSummary(selectedText, cfg);

    await setCacheEntry(cacheKey, { url, ts: Date.now(), summary, usedProvider });

    await chrome.storage.local.set({
      lastSelection: selectedText,
      lastStatus: "done",
      lastStatusText: "",
      lastSummary: summary,
      lastUpdatedAt: Date.now(),
      lastCacheHit: false,
      lastProviderUsed: usedProvider
    });

    await safeSendToTab(tabId, {
      type: "SHOW_PANEL",
      summary,
      statusText: `Summary ready (${usedProvider.toUpperCase()}). Click an item to expand.`
    });
  } catch (err) {
    const msg = String(err?.message || err);

    await chrome.storage.local.set({
      lastStatus: "error",
      lastStatusText: msg,
      lastSummary: {
        items: [{
          id: "1",
          level1: "Error generating summary.",
          level2: msg,
          source_excerpt: ""
        }]
      },
      lastUpdatedAt: Date.now(),
      lastCacheHit: false
    });

    await safeSendToTab(tabId, { type: "PANEL_STATUS", status: "error", text: msg });
  }
});

/* Extension icon click opens in-page panel (no popup) */
chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const { lastSummary, lastStatus, lastStatusText } = await chrome.storage.local.get([
    "lastSummary",
    "lastStatus",
    "lastStatusText"
  ]);
  await safeSendToTab(tab.id, {
    type: "SHOW_PANEL",
    summary: lastSummary || { items: [] },
    statusText: lastStatusText || ""
  });
});
