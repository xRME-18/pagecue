# Changelog

## 0.1.0-beta.2

- Added a real native-WebMCP Chrome test across ten varied layouts and both demos, alongside the deterministic simulated-browser suite; CI now runs both.
- Clearly marked fictional public demos and prevented the registration form from posting data.

## 0.1.0-beta.1

- Extracted the read-and-draw framework as PageCue, separate from the experimental labs site.
- Removed the embedded chatbot, model proxy, bring-your-own-key flow, and non-WebMCP tool fallback.
- Added ESM build, TypeScript entry-point declarations, CSP style nonce, browser tests across varied page shapes, and CI.
- Experimental release: tool names and data attributes use the `pagecue` prefix. No npm publication yet.
