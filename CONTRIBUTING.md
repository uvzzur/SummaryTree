# Contributing

## Run locally

1. Clone the repo.
2. Open Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the project root (where `manifest.json` is).
3. Reload the extension after code changes; refresh the page for content script changes.

## Build

There is no build step. The extension runs as plain JS. Optional: run `npm run lint` and `npm run format` before committing.

## Commit messages

Use short, present-tense descriptions (e.g. “Add options page hint” or “Fix panel CSS encoding”). Conventional Commits (`feat:`, `fix:`) are fine but not required.
