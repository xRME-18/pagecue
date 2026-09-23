# PageCue (beta)

PageCue lets a visitor's **own WebMCP-capable browser agent** read a page's live form state and draw guidance on the page. It exposes no agent tool that submits a form or writes a field. Suggestions appear beside fields; applying one requires the page's Accept control. **It does not provide a chatbot, model proxy, credentials, or an agent.**

> Beta: WebMCP is experimental and is not available in every browser. A browser without `document.modelContext` (or its older `navigator` alias) has no agent-facing PageCue tools. The application remains usable without PageCue.

## Try it locally

```sh
npm ci
npm run check                 # unit tests, build, fresh-browser end-to-end tests, size and package checks
python3 -m http.server 8123  # run from repository root
# Open http://localhost:8123/demo/plain/ or /demo/meridian/
```

For a native WebMCP agent, use a browser build with WebMCP enabled; browser support and flags change while the API is experimental. `npm run test:e2e` uses clean Playwright contexts and a simulated `document.modelContext` for deterministic edge cases. `npm run test:native` additionally launches fresh Chrome with WebMCP testing flags and calls real registered tools through `modelContext.getTools()`/`executeTool()` across ten page layouts and both demos. These checks do **not** prove an external AI agent will discover or use a particular tool.

## Install on a site

This beta has **not been published to npm**. Build from this GitHub repository with `npm ci && npm run build`, then copy the whole `dist/` directory to your site's assets. Do not copy only `auto.js`: the build may use additional chunks.

```html
<script type="module" src="/assets/pagecue/auto.js"></script>
```

The one-line entry exposes `window.pagecue` to the host for `dispose()` and diagnostics. Alternatively, import `{ init }` from `dist/index.js` in your application's own code, call `init()`, and retain the handle. Nothing auto-initializes from the import-only entry.

Set `window.pagecueOptions` **before** the auto script to opt into options such as `ignore`, `protected`, `activity: false`, or `styleNonce` for a host CSP. The tier-1 DOM scanner uses labels, fieldsets and headings; a richer application can supply an `adapter` as documented in `src/pagecue.js`. Mark fields or containers `data-pagecue-protected` to hide their values from the agent and refuse suggestions. See the source interface for `readMask` versus `writeRefuse` when using a custom adapter.

## Authority and privacy

The registered surface is `pagecue.read_page`, `pagecue.point_at`, `pagecue.circle`, `pagecue.link`, `pagecue.suggest_value`, `pagecue.mark_skip`, `pagecue.guide_path`, `pagecue.reveal_section`, `pagecue.clear_ink`, `pagecue.read_activity`, and `pagecue.await_activity` (the last two are omitted when `activity:false`). An adapter's `commit` function is not passed to these tools; it is called only by the suggestion chip's Accept handler.

**Boundary:** this constrains *the PageCue tool surface*, not the browser. A browser agent with separate click/DOM powers could click Accept or interact with the host page directly. Do not use this as proof that a human acted, as a payment-page security control, or as an accessibility-compliance overlay. The in-page activity trail labels browser-dispatched events `input`, **not** `human`; a browser-driving agent is indistinguishable from a person to the page.

PageCue itself does not transmit form data, make model calls, or store API keys. If enabled, the activity trail is an in-memory ring of up to 50 events: free typing is recorded by length, closed choices by selected value, read-masked fields not at all. It vanishes on reload. The host remains responsible for its own page scripts, CSP, privacy notice, and data practices.

## Host security / CSP

The module script must be allowed by `script-src`. The overlay injects a `<style>` element: permit it under your policy or pass a nonce through `window.pagecueOptions = { styleNonce: 'nonce-from-your-server' }` (or `init({ styleNonce })`). The library does not use `innerHTML` or a model endpoint. Test your actual CSP before installation. Pin deployed files to a reviewed release rather than a floating branch; this is a third-party script with ordinary page-script DOM access even though its *agent tools* are read/draw only.

## Status and limitations

- `npm test`: 157 DOM-free unit tests; `npm run test:e2e`: clean Chromium tests across ten varied layouts, both demos and multi-page navigation. `npm run test:native`: fresh flagged Chrome executes real native WebMCP calls on those twelve pages. CI runs all three.
- This is a beta library, not a hosted SaaS or a general-purpose browser agent. No credentials, analytics, or chat are bundled.
- React subtree replacement can drop annotations. No field test covers a multi-page flow; `guide_path` cannot span navigation. Heavy annotation overlap and keyboard/assistive-technology behavior on unfamiliar sites still need manual evaluation.
- Only install where the host approves the script and reviews the forms and fields it will scan. Payment pages require their own compliance and security review.

See [SECURITY.md](SECURITY.md) for the threat model and reporting route. Apache-2.0 licensed.
