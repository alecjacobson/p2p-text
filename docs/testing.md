# Testing connections

## Automated checks

```sh
npm ci
npm test
npm run build
```

CI runs these commands on each pull request. Tests cover CRDT convergence, framing, idle Git checkpoints, one-time signaling, and privacy-filtered ICE diagnostics. They do not prove connectivity through a real NAT or VPN.

## Portable two-browser test

```sh
npm run debug
node debug-session.mjs links https://your-relay.example.org
```

Serve the debug relay at that HTTPS address as described in [networking](networking.md). Open the first printed station link in one browser and the second in another device or browser profile. Treat station links as private control capabilities. The two pages poll for test commands while open. Local-only tests can use `http://127.0.0.1:8787`.

```sh
node debug-session.mjs run lan
node debug-session.mjs run direct
```

Run one command at a time and wait for its result. `lan` disables both STUN and TURN. `direct` enables STUN and disables TURN. Each test creates a fresh document and greeting using randomness in the first browser. The server never generates or receives the greeting. The second browser reports `test-greeting-confirmed` only after receiving it through the CRDT data channel. Type a second message on the guest to verify edits in the reverse direction.

For a forced TURN test, save your own authenticated service configuration in `.p2p-debug/ice.json` and run `node debug-session.mjs run turn`.

```json
{
  "iceServers": [{
    "urls": "turns:relay.example.org:443?transport=tcp",
    "username": "your-temporary-username",
    "credential": "your-temporary-password"
  }]
}
```

There is no default public TURN provider. Test commands expire after ten minutes. The private control files and logs are ignored by Git. `SHORT_OVERLEAF_DEBUG_PROFILE=name` isolates files in `.p2p-debug/name/` and must be set for both relay and control commands.

## Evidence

```sh
tail -F .p2p-debug/events.ndjson
```

Look for `channel-open`, a `stats` record with the selected candidate types, and `test-greeting-confirmed` from the guest. A selected `relay` candidate proves TURN forwarding. Selected `host`, `srflx`, or `prflx` candidates prove a direct route. Merely gathering a public candidate proves neither connectivity nor document delivery.

Logs contain candidate types, state transitions, and abbreviated random attempt IDs. They omit SDP, addresses, codes, TURN credentials, document content, and the greeting. Logging is opt-in with `--debug`, capped at 4,000 events per process. Rotate the ignored log files or restart the relay for another diagnostic session. Debug endpoints accept same-origin requests and station operations require the private station key.

## Live verification on 2026-11-20

| Scenario | Result |
| --- | --- |
| Same Wi-Fi, Firefox on Mac and Linux, VPN disconnected, STUN/TURN disabled | Passed, selected `host → host`, private greeting verified |
| Same Wi-Fi, Mac VPN enabled, direct trials | Failed, VPN address advertised |
| Same Wi-Fi, managed guest Chrome with private candidates suppressed | Direct failed |
| Same Wi-Fi, explicit local coturn relay | Passed, selected `relay → relay`, private greeting verified |
| Independent internet networks, direct | Pending [issue #4](https://github.com/alecjacobson/p2p-text/issues/4) |
| Independent internet networks or VPN with public TURN | Pending [issue #4](https://github.com/alecjacobson/p2p-text/issues/4) |

The live trials used regular installed browsers. No automated Chrome process or browser restart is required for the portable station tests. SSH forwarding, HTTPS hosting, and optional tunnels carry only signaling and diagnostics.

Before closing the external-network issue, repeat the direct and forced-TURN trials using genuinely independent networks, verify bidirectional edits, then stop signaling and verify further edits. Preserve the candidate-type and greeting-confirmation evidence with secrets and text excluded.
