# P2P Text

A peer-to-peer plain-text editor with CRDT merging, local browser storage, and optional Git snapshots. Document updates use encrypted WebRTC data channels.

## Launch

Requires Node.js 22 or later.

```sh
npm ci
npm run relay
```

Open <http://127.0.0.1:8787> in two browser profiles. Generate an invite in one, then enter its six-character code under **Join** in the other.

For different machines, serve this relay through a shared HTTPS address and open that address on both devices. Any HTTPS reverse proxy works. Cloudflare is an optional way to publish localhost. Server-free pairing uses the longer manual invite/reply codes. See [networking and deployment](docs/networking.md).

## Optional Git backup

```sh
npm start -- --repo /path/to/checkout
```

Open <http://127.0.0.1:4173> and enable **Back up this document**. After six seconds without edits, changed text is committed to `p2p-backup`. Add `--push` to push snapshots to `origin`. Each document is saved as `documents/<document-id>.txt`.

## Development

```sh
npm test
npm run build
```

See [connection tests and known limitations](docs/testing.md). Outstanding work is tracked in [GitHub issues](https://github.com/alecjacobson/p2p-text/issues).
