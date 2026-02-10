# Development

## Run

1. Load unpacked in `chrome://extensions` (Developer mode on).
2. Reload the extension after changing background or options; refresh the tab after changing content script or panel CSS.

## DEV_UI_MODE

In `content.js`, set:

```js
const DEV_UI_MODE = true;
```

- Panel opens automatically on page load with dummy summary data.
- No API calls, no background involvement. Use for UI/CSS iteration.
- Set back to `false` for normal use.

## BYOK setup

Open the extension Options (right-click icon → Options, or from the panel gear). Add a Hugging Face token (Settings → Access Tokens on huggingface.co) and/or an OpenAI API key. Provider can be HF, OpenAI, or Auto (HF if token present, else OpenAI).

## Common pitfalls

- **Content script updates**: Changes to `content.js` or `panel.css` apply only after you refresh the page (or reload the extension and then refresh).
- **panel.css**: Must be listed in `web_accessible_resources` in `manifest.json` or the panel styles won’t load.
- **Panel visibility**: The panel only appears when `ensurePanel()` is called — either from a `SHOW_PANEL` / `PANEL_STATUS` message from the background or when `DEV_UI_MODE` is true.
- **Minimize**: Minimize behavior is driven by CSS (e.g. `.minimized` class); avoid overriding with inline styles that would break it.
