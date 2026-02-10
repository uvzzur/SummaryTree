const KEYS = {
  provider: "llmProvider",     // "hf" | "openai" | "auto"
  hfToken: "hfApiToken",
  openaiKey: "openaiApiKey",
  panelDefaultMode: "panelDefaultMode",       // "light" | "dark"
  panelDefaultFontScale: "panelDefaultFontScale"  // number
};

async function clearCacheOnly() {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(
    k => k.startsWith("cache:") || k === "cacheIndex"
  );
  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

document.getElementById("clearCache").addEventListener("click", async () => {
  await clearCacheOnly();
  setStatus("Cache cleared.");
});

document.addEventListener("DOMContentLoaded", async () => {
  const providerEl = document.getElementById("provider");
  const hfEl = document.getElementById("hfToken");
  const openaiEl = document.getElementById("openaiKey");
  const panelModeEl = document.getElementById("panelDefaultMode");
  const panelFontEl = document.getElementById("panelDefaultFontScale");

  const stored = await chrome.storage.local.get([
    KEYS.provider, KEYS.hfToken, KEYS.openaiKey,
    KEYS.panelDefaultMode, KEYS.panelDefaultFontScale
  ]);
  providerEl.value = stored[KEYS.provider] || "hf";
  hfEl.value = stored[KEYS.hfToken] || "";
  openaiEl.value = stored[KEYS.openaiKey] || "";
  panelModeEl.value = stored[KEYS.panelDefaultMode] || "light";
  panelFontEl.value = String(stored[KEYS.panelDefaultFontScale] ?? 1);

  document.getElementById("save").addEventListener("click", async () => {
    await chrome.storage.local.set({
      [KEYS.provider]: providerEl.value,
      [KEYS.hfToken]: hfEl.value.trim(),
      [KEYS.openaiKey]: openaiEl.value.trim(),
      [KEYS.panelDefaultMode]: panelModeEl.value,
      [KEYS.panelDefaultFontScale]: parseFloat(panelFontEl.value)
    });
    /* Clear panel overrides so next panel open uses these defaults */
    await chrome.storage.local.remove(["panelDarkMode", "panelFontScale"]);
    setStatus("Saved.");
  });

  document.getElementById("clear").addEventListener("click", async () => {
    await chrome.storage.local.remove([
      KEYS.provider, KEYS.hfToken, KEYS.openaiKey,
      KEYS.panelDefaultMode, KEYS.panelDefaultFontScale
    ]);
    providerEl.value = "hf";
    hfEl.value = "";
    openaiEl.value = "";
    panelModeEl.value = "light";
    panelFontEl.value = "1";
    setStatus("Cleared.");
  });
});
