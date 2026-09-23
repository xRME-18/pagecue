import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const shapes = [
  ['basic form', '<form onsubmit="window.__submitted=true;return false"><label for="name">Full name</label><input id="name" name="name" required><button type="submit">Send</button></form>'],
  ['fieldset', '<fieldset><legend>Shipping</legend><label for="name">Recipient</label><input id="name" required></fieldset>'],
  ['bootstrap-style', '<div class="form-group"><label for="name">Account</label><input class="form-control" id="name" required></div>'],
  ['GOV.UK-style', '<div class="govuk-form-group"><label class="govuk-label" for="name">Address</label><div class="govuk-hint">Use your home address</div><input id="name" required></div>'],
  ['long page', '<div style="height:1100px">Scroll to the form</div><label for="name">Email</label><input id="name" type="email" required>'],
  ['select and radio', '<label for="name">Category</label><select id="name"><option value="">Choose</option><option value="one">One</option></select><label><input type="radio" name="group" value="yes">Yes</label>'],
  ['dynamic page', '<label for="name">Initial label</label><input id="name"><button id="replace" type="button" onclick="document.querySelector(\'label\').textContent=\'Updated label\'">Update</button>'],
  ['protected and consent', '<label for="name">Public nickname</label><input id="name"><label for="card">Card</label><input id="card" data-pagecue-protected value="sensitive-test-only"><label><input type="checkbox" required>Consent</label>'],
  ['landmarks only', '<h2>Start here</h2><p>Nothing to fill in</p><button>Continue</button>'],
  ['strict CSP and Trusted Types', '<label for="name">CSP-protected field</label><input id="name"><script src="/fixture/csp-config.js"></script>'],
];
const html = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fresh visitor</title><body><h1>Example page</h1>${body}<script type="module" src="/dist/auto.js"></script></body></html>`;
async function withModelContext(context) {
  await context.addInitScript(() => {
    const registered = [];
    Object.defineProperty(document, 'modelContext', { value: {
      registerTool(tool) { registered.push(tool); },
      unregisterTool(name) { const index = registered.findIndex((tool) => tool.name === name); if (index >= 0) registered.splice(index, 1); },
    } });
    window.__registeredTools = registered;
  });
}
const contents = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
let server, browser, base;
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture/csp-config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end("window.pagecueOptions={styleNonce:'testnonce'}"); return;
    }
    const match = /^\/fixture\/(\d+)$/.exec(url.pathname);
    if (match) {
      const shape = shapes[Number(match[1])];
      if (!shape) { res.writeHead(404); res.end(); return; }
      const headers = { 'content-type': 'text/html' };
      if (Number(match[1]) === 9) headers['content-security-policy'] = "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-testnonce'; require-trusted-types-for 'script'";
      res.writeHead(200, headers); res.end(html(shape[1])); return;
    }
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'content-type': contents[path.extname(file)] || 'application/octet-stream' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

for (let i = 0; i < shapes.length; i++) {
  const [name] = shapes[i];
  test(`fresh install: ${name}`, async () => {
    const context = await browser.newContext({ viewport: i % 2 ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    await withModelContext(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/fixture/${i}`);
    await page.waitForFunction(() => !!window.pagecue?.tools);
    const result = await page.evaluate(async () => {
      const tools = Object.fromEntries(window.__registeredTools.map((tool) => [tool.name.replace('pagecue.', ''), tool]));
      const read = await tools.read_page.execute({});
      const fields = read.page.sections.flatMap((s) => s.fields);
      const name = fields.find((f) => f.id === 'name');
      const card = fields.find((f) => f.id === 'card');
      let suggested, refused, before, after;
      if (name?.type !== 'select') {
        before = document.querySelector('#name')?.value;
        suggested = name ? await tools.suggest_value.execute({ field: name.id, value: 'visitor', why: 'review this' }) : null;
        after = document.querySelector('#name')?.value;
      }
      if (card) refused = await tools.suggest_value.execute({ field: card.id, value: 'not-allowed', why: 'do not fill' });
      return { count: window.pagecue.tools.length, surface: window.pagecue.surface,
        fields, landmarks: read.page.landmarks, suggested, refused, before, after, cardValue: card?.value };
    });
    assert.equal(result.count, 11, name);
    assert.equal(result.surface, 'document', name);
    assert.ok(result.landmarks.length > 0, name);
    if (name !== 'landmarks only') assert.ok(result.fields.length > 0, name);
    if (result.suggested) { assert.equal(result.suggested.ok, true, name); assert.equal(result.before, result.after, 'agent tool must not write the input'); }
    if (result.refused) { assert.equal(result.refused.ok, false); assert.notEqual(result.cardValue, 'sensitive-test-only'); }
    if (i === 0) {
      await page.locator('.pagecue-chip-accept').click();
      assert.equal(await page.locator('#name').inputValue(), 'visitor', 'UI acceptance should commit');
      assert.equal(await page.evaluate(() => !!window.__submitted), false, 'Accept must not submit the host form');
    }
    if (i === 9) {
      assert.equal(await page.evaluate(() => document.getElementById('pagecue-overlay-styles')?.nonce), 'testnonce');
      assert.ok(await page.evaluate(() => document.getElementById('pagecue-overlay-styles')?.sheet?.cssRules.length > 0));
    }
    await page.evaluate(() => { window.pagecue.dispose(); window.pagecue.dispose(); });
    assert.deepEqual(await page.evaluate(() => window.__registeredTools.map((tool) => tool.name)), [], 'dispose unregisters WebMCP tools');
    assert.deepEqual(errors, [], name);
    await context.close();
  });
}

test('visitor navigating several pages starts each page with fresh ink and tools', async () => {
  const context = await browser.newContext();
  await withModelContext(context);
  const page = await context.newPage();
  for (const i of [0, 1, 3, 7, 8]) {
    await page.goto(`${base}/fixture/${i}`);
    await page.waitForFunction(() => !!window.pagecue?.tools);
    const state = await page.evaluate(() => ({
      names: window.__registeredTools.map((tool) => tool.name),
      ink: window.pagecue.registry.active().length,
    }));
    assert.equal(state.names.length, 11);
    assert.equal(state.ink, 0, `no annotations should carry over to page ${i}`);
  }
  await context.close();
});

test('source install on both example pages', async () => {
  for (const example of ['plain', 'meridian']) {
    const context = await browser.newContext();
    await withModelContext(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/demo/${example}/`);
    await page.waitForFunction(() => !!window.__registeredTools?.some((tool) => tool.name === 'pagecue.read_page'));
    const read = await page.evaluate(() => window.__registeredTools.find((tool) => tool.name === 'pagecue.read_page').execute({}));
    assert.equal(read.ok, true);
    assert.ok(read.page.sections.flatMap((s) => s.fields).length > 0);
    assert.equal(await page.locator('aside[role="note"]').isVisible(), true, `${example} must identify fictional data`);
    if (example === 'plain') {
      assert.equal(await page.evaluate(() => {
        const event = new Event('submit', { cancelable: true, bubbles: true });
        document.getElementById('registration').dispatchEvent(event);
        return event.defaultPrevented;
      }), true, 'the public demo must not submit registration data');
    }
    assert.deepEqual(errors, [], example);
    await context.close();
  }
});

test('tool registry works when a native WebMCP surface is provided', async () => {
  const context = await browser.newContext();
  await withModelContext(context);
  const page = await context.newPage();
  await page.goto(`${base}/fixture/0`);
  await page.waitForFunction(() => !!window.pagecue?.tools);
  assert.equal(await page.evaluate(() => window.pagecue.surface), 'document');
  assert.ok((await page.evaluate(() => window.__registeredTools.map((tool) => tool.name))).includes('pagecue.read_page'));
  await page.evaluate(() => window.pagecue.dispose());
  assert.deepEqual(await page.evaluate(() => window.__registeredTools.map((tool) => tool.name)), []);
  await context.close();
});
