# Short Overleaf

A peer-to-peer plain-text editor using WebRTC and a CRDT.

## Launch

Requires Node.js 22 or later.

```sh
npm ci
npm run relay
```

Open <http://127.0.0.1:8787>. Choose **Generate invite**, then enter the six-character code under **Join** in the other client. Use two browser profiles to test on one machine.

For remote collaborators, run the relay behind HTTPS and share its app URL. A separate copy of the app can use the relay's `/api/signal` HTTPS URL under **Network settings**. The relay holds pairing data in memory for up to 15 minutes. Edits travel over WebRTC.

For server-free pairing, run `npm run build` and open `dist/index.html` with the signaling endpoint blank. Generate an invite, have your collaborator create a reply, then paste their reply into **Connect peer**. Share pairing codes privately. If direct WebRTC fails, configure TURN under **Network settings**.

## Optional Git backup

Run `npm start -- --repo /path/to/checkout`, open <http://127.0.0.1:4173>, and select **Back up this document**. After six seconds without edits, the helper saves changed text on the `p2p-backup` branch. Add `--push` to push that branch to `origin`.
