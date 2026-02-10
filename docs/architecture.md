# Architecture

SummaryTree is a Chrome MV3 extension. No backend; all LLM calls are made from the service worker using user-provided API keys.

## Pieces

| Piece | Role |
|-------|------|
| **manifest.json** | MV3 config: service worker, content script on `<all_urls>`, options page, `web_accessible_resources` for `panel.css`. |
| **background.js** | Service worker: context menu, selection validation (200–15k chars), LRU cache (~30 items), LLM calls (HF router + OpenAI), JSON parsing and excerpt validation, messaging to the active tab. |
| **content.js** | Injected into every page: builds the right-side panel, handles L1/L2/L3 state, injects `panel.css`, runs highlight logic (DOM text-node index + match). |
| **panel.css** | Panel layout and styling; must be in `web_accessible_resources` or the panel won’t load styles. |
| **options/** | Options page: provider choice, HF token, OpenAI key, default panel theme and font size. Stored in `chrome.storage.local`. |

## Data flow

1. User selects text → right-click → “Traceable summary”.
2. **Background** receives the selection, checks length, optionally serves from cache (key = hash of URL + selection).
3. If not cached: **background** loads provider config, calls Hugging Face or OpenAI, parses JSON, filters items by excerpt-in-selection, writes cache and storage, sends `SHOW_PANEL` to the tab.
4. **Content** receives the message, creates/updates the panel DOM, renders items; on Level 3 click, runs highlight (find excerpt in page text, wrap in `<mark>`).

## Cache

- Key: FNV-1a 32-bit hash of `url + "\n" + selectionText`.
- Storage: `chrome.storage.local` with keys `cache:${hash}` and `cacheIndex` (LRU list, max 30).
- No TTL; eviction is by count.

## BYOK

- Keys live only in `chrome.storage.local` (from the Options page).
- Background reads them when generating; they are never sent anywhere except to Hugging Face or OpenAI for requests the user triggers.
