# P2P Text

A peer-to-peer plain-text editor for people on different computers and networks. Changes merge through a CRDT over encrypted WebRTC data channels. Each browser stores its own copy.

## Run on two machines over the internet

One person hosts the small pairing relay. Requires Node.js 22 or later.

```sh
git clone https://github.com/alecjacobson/p2p-text.git
cd p2p-text
npm ci
npm run relay
```

Make port 8787 reachable through a public HTTPS address. For a quick demo, install `cloudflared` and run this in a second terminal on the relay machine.

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the printed `https://…trycloudflare.com` address. Cloudflare is optional. You can host the relay behind your own HTTPS reverse proxy instead. See [deployment details](docs/networking.md#shared-https-relay).

1. Both people open the **same public HTTPS address** in their browsers.
2. The first person chooses **Generate invite**, then sends **Copy join link** privately to the other person.
3. The second person opens that link and chooses **Connect peer**. Alternatively, choose **Join** on the shared page and enter the six-character code.
4. Once connected, type in either editor. The interface shows whether WebRTC selected a direct connection or TURN.

The collaborator only needs a browser. Pairing codes expire after 15 minutes. Keep the relay and any tunnel running while pairing. Connected peers continue editing after signaling stops.

## TURN for VPNs and restrictive networks

STUN is enabled by default to discover direct internet routes. Some NATs, firewalls, VPNs, and browser policies require a reachable TURN service. An HTTPS tunnel supplies the page and pairing endpoint. TURN supplies an encrypted data route when direct connectivity fails.

Obtain an authenticated TURN service and save its configuration outside the repository, for example `/path/to/private/ice.json`. Replace the example host and credentials with values from your service.

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": "turns:turn.example.org:443?transport=tcp",
      "username": "temporary-user",
      "credential": "temporary-password"
    }
  ],
  "iceTransportPolicy": "all"
}
```

Restart the relay with that file, then reload the shared HTTPS page on both machines and generate a fresh invite.

```sh
npm run relay -- --ice-config /path/to/private/ice.json
```

Both browsers receive these settings automatically. `all` allows ICE to select direct or TURN routes. **Use TURN for all peer traffic** in Network settings forces a TURN test. Credentials are visible to visitors of the hosted app, so use limited-quota or short-lived credentials. Further setup and troubleshooting are in [networking](docs/networking.md#internet-connections-vpns-and-browser-policy).

Direct LAN editing is verified. Independent-network and live VPN/TURN verification remains tracked in [issue #4](https://github.com/alecjacobson/p2p-text/issues/4).

## Manual pairing and local development

For pairing through full invite/reply codes, each person runs `npm ci` and `npm start`, opens their own <http://127.0.0.1:4173>, and exchanges the codes privately. This mode uses the same WebRTC connection rules. See [manual pairing](docs/networking.md#manual-pairing-with-independent-local-clients).

For a one-machine test, run `npm run relay` and open <http://127.0.0.1:8787> in two browser profiles.

## Optional Git backup

```sh
npm start -- --repo /path/to/checkout
```

Open <http://127.0.0.1:4173> on the machine with the checkout and enable **Back up this document**. Use manual pairing or set the shared HTTPS signaling endpoint under Network settings to connect a collaborator. After six seconds without edits, changed text is committed to `p2p-backup`. Add `--push` to push snapshots to `origin`. Each document is saved as `documents/<document-id>.txt`.

## Development

```sh
npm test
npm run build
```

See [connection tests and known limitations](docs/testing.md). Outstanding work is tracked in [GitHub issues](https://github.com/alecjacobson/p2p-text/issues).
