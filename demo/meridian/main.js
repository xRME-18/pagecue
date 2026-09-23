// pagecue/demo/meridian/main.js -- the demo wiring. Three moving parts: the app's
// own store, the app's own view, and one call to PageCue.init with a hooks
// adapter. Nothing pagecue-specific leaks into store.js.
import { createStore } from './store.js';
import { buildForm } from './ui.js';
import { init } from '../../src/pagecue.js';

const { store, writer } = createStore({});
const { page, hooks } = buildForm(store, writer);

// A believable half-finished draft with real mistakes for the agent to find.
const demo = {
  full_name: 'Jordan Rivers',
  policy_no: '228841',                 // wrong format (MM-######)
  email: 'jordan.rivers@fastmail',     // not a valid address
  incident_date: '2026-08-20',
  discovery_date: '2026-08-14',        // before the incident
  cause: 'burst_pipe',
  description: 'Pipe burst behind the kitchen wall overnight, water spread into the living room.',
  emergency_repairs: true,
  repair_cost: '410',
  item1_desc: 'Oak flooring (living room)', item1_value: '1800',
  item2_desc: 'Bookshelf', item2_value: '240',
  total_claimed: '2040',               // forgot the repair cost
};
for (const [k, v] of Object.entries(demo)) writer.setValue(k, v);

const pagecue = init({ root: page, adapter: hooks });

document.getElementById('clear-ink').onclick = () => pagecue.registry.clear();

if (new URLSearchParams(location.search).get('harness') === '1') {
  window.__harness = { store, writer, pagecue, tools: Object.fromEntries(pagecue.tools.map((tool) => [tool.name, tool])) };
}
