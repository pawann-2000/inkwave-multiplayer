# Vendored P2P signaling (online play)

Unmodified `dist/` files from npm, pinned. Loaded only when a player opens the online lobby
(`src/net/transport.js` → `vendor/trystero/nostr/index.mjs`); bare imports resolve through the import map in
`index.html`.

| package | version | files | npm integrity (verified against the downloaded tarball) |
|---|---|---|---|
| `@trystero-p2p/core` | 0.25.4 | `core/*.mjs` (+ maps) | `sha512-ehvSL1FqW962XyEctXngeDF/IOM1bWmfCKBNR4vwmVa0JGfM0+dlY4TEzSEGghYp3qqGCrpFIVTxdvlBUGVO6Q==` |
| `@trystero-p2p/nostr` | 0.25.4 | `nostr/index.mjs` (+ map) | `sha512-QDox1VVHl0ro/CLfQVUtMS9EQbtJhQM7CCsO4SGv9KrPBT+x3bmOqQ4Y6iugsLzQ6sW+a2cwUTxjDRz/BywqMg==` |
| `@noble/secp256k1` | 3.2.0 | `../noble-secp256k1/index.js` | `sha512-Z3ZAWOTxJ0EuTuZTi7Y69iK7GgrLHh8sgm45lVDhg/b3Nk1TpAiKhick2KkZisHuupeepSkyIydN/J459SdX1w==` |

All three are MIT licensed (`LICENSE` files alongside). No install scripts, no transitive runtime dependencies beyond
the three packages above.

To upgrade: `npm pack` the new versions, compare `npm view <pkg>@<ver> dist.integrity` with
`openssl dgst -sha512 -binary <tgz> | base64`, copy `package/dist/*` over, update this table, then run
`node tools/mp-test.mjs` (see docs/NETWORK.md).
