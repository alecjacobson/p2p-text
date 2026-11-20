# Short Overleaf

A peer-to-peer plain-text editor using WebRTC and a CRDT.

## Launch

Requires Node.js 22 or later.

```sh
npm ci
npm run relay
```

For a one-machine test, open <http://127.0.0.1:8787> in two browser profiles. Choose **Generate invite**, then enter the six-character code under **Join** in the second profile.

## Two machines

Run `npm run relay` on **one machine**. Both browsers must open the same HTTPS address for that relay. For a quick test with [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), run this in a second terminal on the relay machine.

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Open the printed HTTPS URL, generate an invite, and send **Copy join link** to your collaborator. The collaborator opens the link and chooses **Connect peer**. The relay holds pairing data for up to 15 minutes. Edits travel over WebRTC.

For server-free pairing, run `npm run build` and open `dist/index.html` with the signaling endpoint blank. Generate an invite, have your collaborator create a reply, then paste their reply into **Connect peer**. Share pairing codes privately. If direct WebRTC fails, configure TURN under **Network settings**.

## Optional Git backup

Run `npm start -- --repo /path/to/checkout`, open <http://127.0.0.1:4173>, and select **Back up this document**. After six seconds without edits, the helper saves changed text on the `p2p-backup` branch. Add `--push` to push that branch to `origin`.
