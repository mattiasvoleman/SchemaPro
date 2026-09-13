# decode-uri-component (vendored, CommonJS)

Upstream `decode-uri-component@0.5.0`, republished locally as CommonJS and wired
in through an `overrides` entry in `mobile/package.json`. `index.js` is upstream's
source verbatim; only the export line differs.

## Why this exists

GHSA-vcc3-ghjq-m6fr / CVE-2026-45822: every `decode-uri-component` up to and
including 0.4.2 burns superlinear CPU on malformed percent-encoded input. It is
reachable in this app — `expo-router` parses the query string of every incoming
deep link through `query-string`, which decodes each value with this package.
A `schemapro://` link carrying a malformed value is enough, and because the
JavaScript thread is the UI thread, the app freezes rather than slows:

| malformed value | 0.2.2 (what we shipped) | 0.5.0 (this package) |
| --------------- | ----------------------- | -------------------- |
| 600 chars       | 1.4 s                   | < 1 ms               |
| 1 500 chars     | 16.6 s                  | < 1 ms               |
| 3 000 chars     | > 60 s                  | 1 ms                 |

The fix exists upstream, but only as ESM. It cannot be consumed here:

- The only consumer is `query-string@7.1.3`, which is CommonJS and does
  `const decodeComponent = require('decode-uri-component')`.
- A plain `overrides` bump to 0.5.0 hands that `require()` a module namespace
  (Node) or `{default: fn}` (Metro's Babel transform), so the call fails with
  *decodeComponent is not a function* — verified both ways.
- Overriding `query-string` to 9.5.1 fails symmetrically: it is ESM with only a
  default export, and expo-router's `__importStar(require('query-string'))`
  yields `{__esModule, default}`, so `queryString.stringify` is undefined.
- Upgrading expo-router does not help. Every release through the 58 canary pins
  `query-string: ^7.1.3`.

Third-party CommonJS republishes of 0.5.0 exist on npm but were rejected:
swapping a 20 M-downloads/week package for a 20-downloads/week republisher is a
supply-chain trade that costs more than the local denial of service it buys.

## The one thing to know before touching this

`npm audit` cannot see a `file:` dependency. Nothing will tell you when a future
advisory lands against `decode-uri-component` — the mobile audit gate goes green
past this package, not through it. `src/services/deepLinkDecoding.test.ts` guards
the behaviour, not the advisory feed.

## Re-syncing with upstream

Delete this directory and drop the override the moment `query-string` 7 is out of
the tree — i.e. when expo-router moves to a `query-string` that is not ESM-hostile
to its own consumers, or ships its own parsing. Check with:

```bash
npm ls query-string --package-lock-only --all --prefix mobile
```

To pull a newer upstream patch in the meantime:

```bash
npm pack decode-uri-component@<version>          # unpack somewhere scratch
cp <unpacked>/index.js mobile/vendor/decode-uri-component/index.js
```

then re-apply the two local edits — the header comment, and changing
`export default function decodeUriComponent(` to
`module.exports = function decodeUriComponent(` — bump `version` in this
directory's `package.json`, and confirm the diff is exactly one line:

```bash
diff <(tail -n +10 mobile/vendor/decode-uri-component/index.js) <unpacked>/index.js
```
