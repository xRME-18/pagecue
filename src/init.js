// pagecue/src/init.js -- the canonical one-line install.
//
//   <script type="module" src="/pagecue/src/init.js"></script>
//
// This file exists because an INLINE `<script type="module">` that imports from
// /public is rejected by Vite with a 500 ("does not provide an export named" /
// refused public import). An external module file is served as-is by every dev
// server we tested, so the documented install is a file, not a snippet.
//
// Configure by setting window.pagecueOptions BEFORE this tag -- same options as
// init(), e.g. { ignore: ['#devtools'], protected: ['#card'] }.

import { init } from './pagecue.js';

window.pagecue = init(window.pagecueOptions || {});
