# Security policy

PageCue is a beta, not a security boundary for the whole browser or host page. It deliberately exposes read-and-draw tools to a visitor's WebMCP agent. It does not expose `commit` or `submit` as agent tools. A browser-driving agent may still click the page's Accept button or operate other host controls; `isTrusted` is not human attestation.

## Report a vulnerability

Use GitHub's **Report a vulnerability** private advisory flow for this repository. Please do not include real user data, tokens, payment values, or account credentials in a public issue. Security fixes have no guaranteed SLA for this beta.

## Data and trust boundaries

- The library is a third-party script with ordinary access to the host DOM; the host must review and approve it.
- Read-masked values are removed before tool results; marking sensitive fields is the site's responsibility. The tier-1 DOM adapter masks password-like fields automatically, but review your own field types and custom adapters.
- The optional activity trail lives in page memory and does not attest whether a person or browser agent caused input. No telemetry or external model calls are made by the library.
- Strict CSP hosts should pass `styleNonce`; test in the host's environment. No `innerHTML`/Trusted Types policy is required by the library.
- A version-pinned build protects against silent upgrades; repository source, a GitHub release, and an npm package are different artifacts. There is no npm publication yet.
