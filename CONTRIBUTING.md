# Contributing

This is a beta WebMCP library. Please open an issue describing the host page shape and expected tool behavior before large changes. Never include actual form values, auth cookies, model keys, or customer data.

Run `npm ci`, `npx playwright install chromium chrome`, `npm run check`, and `npm run test:native` before submitting a pull request. The tests use a clean browser and intentionally synthetic data. Changes to registered tool names, descriptions or JSON schemas affect agent behavior: describe them explicitly in the PR and changelog, even when the JavaScript API does not change. Do not weaken the read-mask or commit boundary for convenience.

By contributing you agree that your changes are licensed under the repository's Apache-2.0 license. Do not submit code or art you cannot license on these terms.
