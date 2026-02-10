/***********************
 * Traceable Summary - content.js
 * - Right-side panel injected into the page
 * - Panel CSS loaded from panel.css (easier to edit)
 * - Click items to expand Level 1 → 2 → 3
 * - Level 3 highlights source excerpt on the page
 ***********************/

console.log("Traceable Summary content script loaded");

const DEV_UI_MODE = false; // ← set to false for real usage

const DUMMY_SUMMARY = {
  title: "Climate Report Summary: Key Findings and Policy Implications",
  items: [
    {
      id: "1",
      level1: "Global temperatures have risen about 1.1°C since pre-industrial levels, with the last decade the warmest on record.",
      level2: "The report states that human activity is the main driver of warming, and that without rapid cuts in greenhouse gas emissions the world will miss the 1.5°C target. Heat waves, droughts, and heavy rainfall have become more frequent and intense in many regions.",
      source_excerpt:
        "Global temperatures have risen about 1.1°C since pre-industrial levels, and the last decade was the warmest on record. Human influence has warmed the climate at a rate unprecedented in at least the last 2,000 years."
    },
    {
      id: "2",
      level1: "The report calls for immediate, large-scale reductions in CO₂ and other emissions to limit further warming.",
      level2: "It outlines pathways that would require reaching net-zero CO₂ by mid-century and deep cuts in methane. Delaying action increases the risk of crossing irreversible thresholds and raises adaptation costs.",
      source_excerpt:
        "Limiting warming to 1.5°C or 2°C requires immediate, rapid and large-scale reductions in greenhouse gas emissions. Reaching net-zero CO₂ emissions is a prerequisite for stabilising warming, alongside strong reductions in other greenhouse gases."
    },
    {
      id: "3",
      level1: "Regional impacts vary: some areas face greater risks from sea-level rise, others from water scarcity or extreme heat.",
      level2: "Coastal cities and small islands are especially vulnerable to sea-level rise and storms. Inland regions may see more drought and crop failures. The report stresses that adaptation and mitigation must go hand in hand.",
      source_excerpt:
        "Climate change is already affecting every region on Earth. Regional differences in precipitation, glacier melt, and sea-level rise will shape local impacts. Adaptation can reduce risks but has limits if warming is not curtailed."
    }
  ]
};

let activeMarks = [];
const PANEL_ID = "traceable-summary-panel";
let panelState = {
  title: "",
  items: [],
  levelById: {},
  status: "",
  statusText: ""
};

function injectCssFile() {
  if (document.getElementById("ts-panel-css")) return;

  const link = document.createElement("link");
  link.id = "ts-panel-css";
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("panel.css");

  link.onload = () => console.log("panel.css loaded:", link.href);
  link.onerror = () => console.log("panel.css failed to load:", link.href);

  document.documentElement.appendChild(link);
}

/* Highlighting: DOM walk, index, match, wrap in <mark> */

function normalizeForMatch(s) {
  if (!s) return "";
  s = s.replace(/\u00A0/g, " ");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, " ");
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/[–—]/g, "-");
  return s;
}

function scrubCitationsPreserveLength(s) {
  if (!s) return "";
  s = normalizeForMatch(s);
  s = s.replace(/\[\s*\d+\s*\]/g, (m) => " ".repeat(m.length));
  s = s.replace(/\[\s*citation needed\s*\]/gi, (m) => " ".repeat(m.length));
  s = s.replace(/\[\s*[a-z][^\]]{0,40}\]/gi, (m) => " ".repeat(m.length));
  s = s.replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰]/g, " ");
  s = s.replace(/[\u2070-\u2079]/g, " ");
  return s;
}

function clearMarks() {
  for (const mark of activeMarks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parent.normalize();
  }
  activeMarks = [];
}

function getTextNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName?.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return NodeFilter.FILTER_REJECT;
      if (parent.closest && parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT; // don't index our panel
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

function buildIndex(nodes) {
  let rawText = "";
  const ranges = [];

  const needsSpaceBetween = (prev, next) => {
    if (!prev || !next) return false;
    const prevText = prev.nodeValue || "";
    const nextText = next.nodeValue || "";
    const prevEndsSpace = /\s$/.test(prevText);
    const nextStartsSpace = /^\s/.test(nextText);
    return !prevEndsSpace && !nextStartsSpace;
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (i > 0 && needsSpaceBetween(nodes[i - 1], node)) {
      const s = rawText.length;
      rawText += " ";
      ranges.push({ node: null, start: s, end: s + 1 });
    }

    const start = rawText.length;
    rawText += node.nodeValue;
    const end = rawText.length;
    ranges.push({ node, start, end });
  }

  return { rawText, ranges };
}

function collapseWithMap(raw) {
  let collapsed = "";
  const map = [];

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== " ") {
        collapsed += " ";
        map.push(i);
      }
      i = j;
    } else {
      collapsed += ch;
      map.push(i);
      i++;
    }
  }

  return { collapsed, map };
}

function findMatchUsingCollapsed(rawText, needle) {
  const rawScrubbed = scrubCitationsPreserveLength(rawText);
  const ndlScrubbed = scrubCitationsPreserveLength(needle);

  const { collapsed: rawC, map: rawMap } = collapseWithMap(rawScrubbed);
  const { collapsed: ndlC } = collapseWithMap(ndlScrubbed);

  const ndl = (ndlC || "").trim();
  if (!ndl || ndl.length < 10) return null;

  const idxC = rawC.indexOf(ndl);
  if (idxC === -1) return null;

  const startRaw = rawMap[idxC];
  const endRaw = rawMap[idxC + ndl.length - 1] + 1;
  return { startRaw, endRaw };
}

function locateWindowByExcerptAnchorsRobust(rawText, excerpt) {
  const rawScrubbed = scrubCitationsPreserveLength(rawText);
  const exScrubbed = scrubCitationsPreserveLength(excerpt);

  const { collapsed: rawC, map: rawMap } = collapseWithMap(rawScrubbed);
  const { collapsed: exC } = collapseWithMap(exScrubbed);

  const ex = (exC || "").trim();
  if (ex.length < 20) return null;

  for (const k0 of [60, 40, 30]) {
    const k = Math.min(k0, ex.length);
    const startAnchor = ex.slice(0, k);
    const endAnchor = ex.slice(ex.length - k);

    const startIdxC = rawC.indexOf(startAnchor);
    if (startIdxC === -1) continue;

    const endIdxC = rawC.indexOf(endAnchor, startIdxC + startAnchor.length);
    if (endIdxC === -1) continue;

    const startRaw = rawMap[startIdxC];
    const endRaw = rawMap[endIdxC + endAnchor.length - 1] + 1;

    if (startRaw < endRaw) return { startRaw, endRaw };
  }

  const words = ex.split(/\s+/).filter(Boolean);
  if (words.length < 6) return null;

  const firstWords = words.slice(0, Math.min(8, words.length)).join(" ");
  const lastWords = words.slice(Math.max(0, words.length - 8)).join(" ");

  const startIdxC2 = rawC.indexOf(firstWords);
  if (startIdxC2 === -1) return null;

  const endIdxC2 = rawC.indexOf(lastWords, startIdxC2 + firstWords.length);
  if (endIdxC2 === -1) return null;

  const startRaw2 = rawMap[startIdxC2];
  const endRaw2 = rawMap[endIdxC2 + lastWords.length - 1] + 1;

  if (startRaw2 < endRaw2) return { startRaw: startRaw2, endRaw: endRaw2 };
  return null;
}

function highlightRange(ranges, startIdx, endIdx) {
  for (const r of ranges) {
    if (!r.node) continue;

    const overlapStart = Math.max(startIdx, r.start);
    const overlapEnd = Math.min(endIdx, r.end);
    if (overlapStart >= overlapEnd) continue;

    const node = r.node;
    const text = node.nodeValue || "";

    const localStart = overlapStart - r.start;
    const localEnd = overlapEnd - r.start;

    const before = text.slice(0, localStart);
    const match = text.slice(localStart, localEnd);
    const after = text.slice(localEnd);

    const parent = node.parentNode;
    if (!parent) continue;

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));

    const mark = document.createElement("mark");
    mark.textContent = match;
    frag.appendChild(mark);
    activeMarks.push(mark);

    if (after) frag.appendChild(document.createTextNode(after));

    parent.replaceChild(frag, node);
  }

  if (activeMarks.length) {
    activeMarks[0].scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function findAndMark(excerpt) {
  clearMarks();

  if (!excerpt || excerpt.trim().length < 10) {
    return { ok: false, reason: "Excerpt too short" };
  }

  const nodes = getTextNodes();
  const { rawText, ranges } = buildIndex(nodes);

  let idx = rawText.indexOf(excerpt);
  if (idx !== -1) {
    highlightRange(ranges, idx, idx + excerpt.length);
    return { ok: true };
  }

  const m = findMatchUsingCollapsed(rawText, excerpt);
  if (m) {
    highlightRange(ranges, m.startRaw, m.endRaw);
    return { ok: true };
  }

  const exWindow = locateWindowByExcerptAnchorsRobust(rawText, excerpt);
  if (exWindow) {
    highlightRange(ranges, exWindow.startRaw, exWindow.endRaw);
    return { ok: true };
  }

  return { ok: false, reason: "Not found" };
}

/* Panel UI */

function applyPanelPreferences(panel) {
  chrome.storage.local.get([
    "panelDarkMode", "panelFontScale",
    "panelDefaultMode", "panelDefaultFontScale"
  ], (obj) => {
    const isDark = obj.panelDarkMode === true || (obj.panelDarkMode == null && obj.panelDefaultMode === "dark");
    const scale = typeof obj.panelFontScale === "number" ? obj.panelFontScale
      : (typeof obj.panelDefaultFontScale === "number" ? obj.panelDefaultFontScale : 1);
    if (isDark) {
      panel.classList.add("dark");
      const btn = panel.querySelector("#tsDarkBtn");
      if (btn) {
        btn.textContent = "◑";
        btn.title = "Light mode";
      }
    } else {
      panel.classList.remove("dark");
      const btn = panel.querySelector("#tsDarkBtn");
      if (btn) {
        btn.textContent = "◐";
        btn.title = "Glossy dark mode";
      }
    }
    panel.style.setProperty("--ts-font-scale", String(scale));
  });
}

function ensurePanel() {
  injectCssFile();

  let panel = document.getElementById(PANEL_ID);
  if (panel) {
    applyPanelPreferences(panel);
    return panel;
  }

  panel = document.createElement("div");
  panel.id = PANEL_ID;

panel.style.zIndex = "2147483647";

  panel.innerHTML = `
    <div class="hdr">
      <div class="hdrSpacer">
        <div class="statusRow hidden" id="tsStatusRow">
          <div class="spinner"></div>
          <div id="tsStatusText"></div>
        </div>
      </div>
      <div class="hdrBtns">
        <button id="tsFontDown" title="Decrease font size">A−</button>
        <button id="tsFontUp" title="Increase font size">A+</button>
        <button id="tsDarkBtn" title="Glossy dark mode">◐</button>
        <button id="tsSettingsBtn" title="Settings">⚙</button>
        <button id="tsMinBtn" title="Minimize">–</button>
        <button id="tsCloseBtn" title="Close panel">×</button>
      </div>
    </div>
    <div class="list" id="tsList"></div>
  `;

  document.documentElement.appendChild(panel);

  panel.querySelector("#tsCloseBtn").addEventListener("click", () => panel.remove());

  panel.querySelector("#tsSettingsBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });

  panel.querySelector("#tsDarkBtn").addEventListener("click", () => {
    panel.classList.toggle("dark");
    const isDark = panel.classList.contains("dark");
    chrome.storage.local.set({ panelDarkMode: isDark });
    const btn = panel.querySelector("#tsDarkBtn");
    btn.textContent = isDark ? "◑" : "◐";
    btn.title = isDark ? "Light mode" : "Glossy dark mode";
  });

  panel.querySelector("#tsMinBtn").addEventListener("click", () => {
    panel.classList.toggle("minimized");
    const btn = panel.querySelector("#tsMinBtn");
    btn.textContent = panel.classList.contains("minimized") ? "+" : "–";
  });

  function applyFontScale(scale) {
    panel.style.setProperty("--ts-font-scale", String(scale));
    chrome.storage.local.set({ panelFontScale: scale });
  }
  panel.querySelector("#tsFontDown").addEventListener("click", () => {
    const next = Math.max(0.75, (parseFloat(panel.style.getPropertyValue("--ts-font-scale")) || 1) - 0.1);
    applyFontScale(next);
  });
  panel.querySelector("#tsFontUp").addEventListener("click", () => {
    const next = Math.min(1.35, (parseFloat(panel.style.getPropertyValue("--ts-font-scale")) || 1) + 0.1);
    applyFontScale(next);
  });

  applyPanelPreferences(panel);

  panel.querySelector("#tsList").addEventListener("click", (e) => {
    const card = e.target.closest(".item");
    if (!card) return;

    const id = card.dataset.id;
    const it = panelState.items.find(x => String(x.id) === String(id));
    if (!it) return;

    const current = panelState.levelById[id] ?? 1;
    const next = current === 3 ? 1 : Math.min(3, current + 1);
    panelState.levelById[id] = next;

    renderPanel();

    if (next === 3 && it.source_excerpt) {
      const res = findAndMark(it.source_excerpt);
      if (!res.ok) {
        setStatus("error", `Could not highlight: ${res.reason}`);
      }
      /* On success, no status message; highlight is visible on page */
    }
  });

  return panel;
}

function setStatus(kind, text) {
  const panel = ensurePanel();
  panelState.status = kind || "";
  panelState.statusText = text || "";

  /* Spinner only when loading; hide on error or done */
  panel.classList.toggle("loading", panelState.status === "loading");
  const statusRow = panel.querySelector("#tsStatusRow");
  const statusTextEl = panel.querySelector("#tsStatusText");
  if (!statusRow || !statusTextEl) return;

  const show = panelState.status === "loading" || panelState.status === "error";
  statusRow.classList.toggle("visible", show);
  statusRow.classList.toggle("hidden", !show);
  statusTextEl.textContent = panelState.statusText || (panelState.status === "loading" ? "Thinking…" : "");

  if (panelState.status === "done") {
    if (panelState._doneTimer) clearTimeout(panelState._doneTimer);
    panelState._doneTimer = setTimeout(() => {
      statusRow.classList.remove("visible");
      statusRow.classList.add("hidden");
      statusTextEl.textContent = "";
      panelState._doneTimer = null;
    }, 1500);
  }
}

function renderPanel() {
  const panel = ensurePanel();
  panel.classList.toggle("loading", panelState.status === "loading");

  const list = panel.querySelector("#tsList");
  list.innerHTML = "";

  const items = panelState.items || [];
  const title = (panelState.title || "").trim();

  if (!items.length) {
    list.innerHTML = `<div class="emptyHint">No items yet. Select text → right-click → Traceable summary.</div>`;
    return;
  }

  if (title) {
    const titleEl = document.createElement("div");
    titleEl.className = "summaryTitle";
    titleEl.textContent = title;
    list.appendChild(titleEl);
  }

  for (const it of items) {
    const id = String(it.id);
    const level = panelState.levelById[id] ?? 1;

    const div = document.createElement("div");
    div.className = "item" + (level >= 2 ? " item-expanded" : "");
    div.dataset.id = id;

    /* Hierarchical tree: L1 always visible, L2/L3 stack below with indent */
    const l1 = escapeHtml(it.level1 || "");
    const l2 = it.level2 || "";
    const l3 = it.source_excerpt || "";
    const showL2 = level >= 2 && l2;
    const showL3 = level >= 3 && l3;

    div.innerHTML = `
      <div class="item-level1">${l1}</div>
      ${showL2 ? `<div class="item-level2">${escapeHtml(l2)}</div>` : ""}
      ${showL3 ? `<div class="item-level3">\u201C${escapeHtml(l3)}\u201D</div>` : ""}
    `;

    list.appendChild(div);
  }
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

/* Message handling */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "HIGHLIGHT_EXCERPT") {
    const res = findAndMark(msg.excerpt || "");
    sendResponse(res);
    return;
  }

  if (msg.type === "CLEAR_HIGHLIGHT") {
    clearMarks();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "SHOW_PANEL") {
    ensurePanel();
    const summary = msg.summary || {};
    panelState.title = summary.title || "";
    panelState.items = summary.items ? summary.items : [];
    panelState.levelById = {};
    setStatus("done", "");
    renderPanel();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "PANEL_STATUS") {
    ensurePanel();
    setStatus(msg.status || "", msg.text || "");
    if (msg.summary) {
      panelState.title = msg.summary.title || "";
      if (msg.summary.items) {
        panelState.items = msg.summary.items;
        panelState.levelById = {};
      }
      renderPanel();
    }
    sendResponse({ ok: true });
    return;
  }
});

if (DEV_UI_MODE) {
  console.log("Traceable Summary: DEV UI MODE enabled");

  const panel = ensurePanel();
  panelState.title = DUMMY_SUMMARY.title || "";
  panelState.items = DUMMY_SUMMARY.items;
  panelState.levelById = {};
  setStatus("done", "UI Dev Mode — dummy data");
  renderPanel();
}