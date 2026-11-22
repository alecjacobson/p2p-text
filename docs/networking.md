# Networking and deployment

## Connection paths

| Component | Purpose | Lifetime |
| --- | --- | --- |
| HTTPS/static hosting | Deliver the browser app | Page load |
| Signaling relay | Exchange an offer and reply for a six-character code | Pairing only, at most 15 minutes |
| STUN | Discover possible public network addresses | ICE gathering and connectivity |
| TURN, when configured | Forward encrypted WebRTC packets if ICE selects a relay route | Connected session |
| Browser peers | Store and merge CRDT operations | Editing session |

The signaling relay keeps expiring handshakes in memory. It deletes them after the reply is accepted and stores no document text. A single lightweight relay can pair unrelated documents. A connected document does not need a running signaling process to keep syncing.

TURN carries edits when the selected route uses it. TURN handles encrypted WebRTC transport and has no CRDT or document-management logic. Direct connections send edits between the peers. ICE tries available routes using the browser's network settings. [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections)

## Shared HTTPS relay

```sh
npm ci
npm run relay
```

Publish port 8787 through an HTTPS reverse proxy that preserves the request host and origin. Open the same HTTPS address on both machines. Generate an invite and use **Copy join link**, or enter the six-character code in the second browser.

The relay binds to `127.0.0.1` by default. Use `npm run relay -- --host 0.0.0.0 --port 8787` when a container or remote reverse proxy needs to reach it. The public browser origin must use HTTPS. A code belongs to the relay that issued it, so separate localhost relays cannot look up each other's codes.

Cloudflare is optional. For a quick tunnel, install `cloudflared` and run the following separately while the relay runs.

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

Both browsers open the printed HTTPS URL. The tunnel publishes the page and carries signaling. It does not turn an unreachable WebRTC candidate into a usable data route. The source has no Cloudflare SDK, discovery logic, or required Cloudflare service.

## Manual pairing with independent local clients

```sh
npm start
```

Each peer opens their own <http://127.0.0.1:4173>. Leave **Signaling endpoint** blank. The inviter generates the full invite code, the guest pastes it under **Join** and creates a reply, then the inviter pastes that reply. A local Git backup can run in either peer's helper.

Alternatively, `npm run build` produces a self-contained `dist/index.html` that can be served by a static HTTPS host. File URLs work in browsers that expose the required WebRTC, storage, and secure-context APIs there. Localhost or HTTPS is the reproducible launch path.

Manual signaling works over an existing private communication channel and needs no app signaling server. The full codes contain SDP and can be long. Six-character codes need a shared rendezvous service because six characters cannot encode all connection parameters.

## Internet connections, VPNs, and browser policy

WebRTC supports connections between different networks. STUN is enabled by default. A usable direct route depends on NAT, firewall, VPN, IPv6, and browser policy. TURN is needed when those networks provide no working direct route.

Configure **TURN URL**, **TURN username**, and **TURN password** under **Network settings** on both clients before generating a fresh invite. A TURN service reachable over TCP/TLS, commonly `turns:relay.example.org:443?transport=tcp`, can work on networks that block direct UDP. A VPN or firewall can also block that service, so availability requires a real network test.

A shared relay can supply the same ICE settings to both browsers, so collaborators only open the shared HTTPS page and exchange an invite.

```sh
npm run relay -- --ice-config /path/to/private/ice.json
```

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": [
        "turn:relay.example.org:3478?transport=udp",
        "turns:relay.example.org:443?transport=tcp"
      ],
      "username": "temporary-user",
      "credential": "temporary-password"
    }
  ],
  "iceTransportPolicy": "all"
}
```

The default `all` policy lets ICE select direct or TURN routes. To verify a TURN path, select **Use TURN for all peer traffic** before creating the invite, or set `iceTransportPolicy` to `relay` in the file. Relay-only mode requires authenticated TURN. Both peers need a reachable route, so enable the same settings on both for a controlled test.

Hosted settings appear under **Use network settings from this host**. Uncheck that option to supply individual settings. The file is read at startup. Restart the relay and reload both pages after updating it. The values are delivered to every visitor of that relay and remain visible in the browser. Use a dedicated limited-quota TURN account or short-lived service credentials and keep the file outside Git. Credential issuance and renewal are the operator's responsibility. The app does not log the values or store them in local storage.


In the observed failure on 2026-11-20, the Mac advertised a VPN interface address. With the VPN disconnected, Firefox on both machines connected directly on Wi-Fi. Chrome on the guest also had the managed `WebRtcIPHandling=default_public_interface_only` policy, suppressing private-address candidates. Fresh profiles inherit system policies. Administrators can inspect `chrome://policy` and scope approved WebRTC policies to the application origin. [Chromium policy definition](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/WebRtc/WebRtcIPHandling.yaml)

The connected UI shows whether ICE selected a direct or TURN route. Failed connections inspect ICE statistics even when server diagnostics are disabled and provide VPN, browser-policy, local-network-permission, and TURN recovery advice. A webpage cannot reliably identify a VPN or select a physical network interface. After changing networks, create a fresh invite so ICE gathers current candidates. Document text remains in browser storage after a connection fails. See the [live verification matrix](testing.md) for what has actually been tested.

## Prototype limits

Each invitation connects two clients. Add more peers with separate invitations. Updates propagate through the connected graph. Closing the only connecting peer can split that graph and requires pairing again. Reloading restores local text and requires a fresh connection.

CRDT operations and deletion history grow with editing history. There is no compaction. Browser frames are bounded at 8 MiB and local Git snapshots at 2 MiB. Git snapshots store the current plain text. A non-fast-forward push reports a conflict instead of overwriting another writer's history.

Share codes privately and verify the collaborator through that channel. Six-character codes are short-lived, single-use capabilities with bounded server-side lookup rates. The prototype has no accounts, audited identity verification, or durable rendezvous storage. A signaling operator can see connection metadata. Each TURN client receives its service credentials. Use a single relay process or sticky routing for the in-memory mailbox.
