import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { diagnosticHandler, sanitizeDiagnostic } from '../diagnostics.mjs';
import { configuredTurn, createStations, newRun, newStationKeys, stationLinks } from '../debug-stations.mjs';
import { browserFamily, descriptionCandidates, reportIceStats } from '../src/rtc-diagnostics.js';
import { shareableJoinLink } from '../src/relay.js';

const tag = { role: 'invite', attempt: 'abcd1234', peer: 'ef015678' };

test('diagnostic records retain only structured connection fields', () => {
  assert.deepEqual(sanitizeDiagnostic({
    ...tag, event: 'candidate-error', code: 701, scheme: 'stun',
    url: 'turn:user:password@example.net', address: '192.0.2.1', codeText: 'SECRET', text: 'greeting'
  }), {
    ...tag, source: 'browser', event: 'candidate-error', code: 701, scheme: 'stun'
  });
  assert.equal(sanitizeDiagnostic({ ...tag, event: 'raw-sdp' }), null);
});

test('the diagnostic endpoint accepts same-origin records', async () => {
  const records = [];
  const handle = diagnosticHandler(record => records.push(record));
  async function send(origin) {
    const body = Buffer.from(JSON.stringify({ ...tag, event: 'channel-open' }));
    const request = Object.assign(Readable.from([body]), {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'relay.example.org', origin }
    });
    let status;
    await handle(request, { writeHead(code) { status = code; return this; }, end() {} });
    return status;
  }
  assert.equal(await send('https://other.example.org'), 403);
  assert.equal(await send('https://relay.example.org'), 204);
  assert.equal(records.length, 1);
});

test('ICE stats summarize the selected pair without including addresses', async () => {
  const stats = new Map([
    ['a', { type: 'local-candidate', candidateType: 'relay', address: '203.0.113.1' }],
    ['b', { type: 'remote-candidate', candidateType: 'srflx', address: '192.0.2.1' }],
    ['p', { type: 'candidate-pair', state: 'succeeded', responsesReceived: 2, localCandidateId: 'a', remoteCandidateId: 'b' }],
    ['t', { type: 'transport', selectedCandidatePairId: 'p' }]
  ]);
  const logs = [];
  await reportIceStats({ getStats: async () => stats }, (event, fields) => logs.push({ event, ...fields }));
  assert.deepEqual(logs, [{
    event: 'stats', pairs: 1, succeeded: 1, requests: 0, responses: 2,
    localHost: 0, remoteHost: 0, localRelay: 1, remoteRelay: 0,
    local: 'relay', remote: 'srflx'
  }]);
});

test('direct diagnostics count advertised candidate types without addresses', () => {
  assert.equal(browserFamily('Mozilla Chrome/140.0.0.0 Safari/537.36'), 'chromium');
  assert.equal(browserFamily('Mozilla Version/18.6 Safari/605.1.15'), 'webkit');
  const sdp = [
    'a=candidate:one 1 udp 2122194687 testname.local 65218 typ host',
    'a=candidate:two 1 udp 1685987071 203.0.113.1 39000 typ srflx raddr 0.0.0.0 rport 0'
  ].join('\r\n');
  assert.deepEqual(descriptionCandidates(sdp), { host: 1, hostMdns: 1, srflx: 1, relay: 0 });
});

test('LAN tests configure no STUN or TURN service', async () => {
  const keys = newStationKeys();
  const run = newRun('lan');
  const stations = createStations(() => {}, async () => keys, async () => run, [{ urls: 'turn:example.org' }]);
  await stations({ action: 'poll', key: keys.join, client: crypto.randomUUID() });
  const { payload } = await stations({ action: 'poll', key: keys.invite, client: crypto.randomUUID() });
  assert.equal(payload.task.mode, 'lan');
  assert.deepEqual(payload.task.ice, []);
});

test('only explicit test links request auto-join', () => {
  const endpoint = 'https://relay.example.org/api/signal';
  assert.equal(new URL(shareableJoinLink(endpoint, 'ABCD23')).hash, '#join=ABCD23');
  assert.equal(new URL(shareableJoinLink(endpoint, 'ABCD23', true)).hash, '#join=ABCD23&auto=1');
});

test('two opted-in stations exchange a fresh TURN test invite without logging credentials', async () => {
  const keys = newStationKeys();
  const links = stationLinks(keys, 'https://relay.example.org/');
  assert.equal(new URL(links.join).hash, `#station=${keys.join}`);
  const run = { ...newRun('turn'), ice: [{ urls: 'turns:relay.example.org:443', username: 'test', credential: 'test-password' }] };
  const records = [];
  const stations = createStations(record => records.push(record), async () => keys, async () => run);
  const clients = { [keys.invite]: crypto.randomUUID(), [keys.join]: crypto.randomUUID() };
  const poll = key => stations({ action: 'poll', key, client: clients[key] });
  assert.equal((await poll('0'.repeat(32))).status, 403);
  assert.equal((await poll(keys.invite)).payload.task, undefined);
  assert.equal((await poll(keys.join)).payload.task, undefined);
  const host = (await poll(keys.invite)).payload.task;
  assert.equal(host.id, run.id);
  assert.equal(host.mode, 'turn');
  assert.match([host.ice[0].urls].flat()[0], /^turns?:/);
  assert.ok(host.ice[0].credential);
  const duplicate = await stations({ action: 'poll', key: keys.invite, client: crypto.randomUUID() });
  assert.deepEqual(duplicate.payload, { role: 'invite', standby: true });

  const invite = { action: 'publish', id: run.id, code: 'ABCD23' };
  assert.equal((await stations({ ...invite, key: keys.join, client: clients[keys.join] })).status, 409);
  assert.equal((await stations({ ...invite, key: keys.invite, client: clients[keys.invite] })).status, 200);
  const guest = (await poll(keys.join)).payload.task;
  assert.equal(guest.code, invite.code);
  assert.deepEqual(guest.ice, host.ice);
  assert.equal((await poll(keys.invite)).payload.task, undefined);
  assert.ok(!JSON.stringify(records).includes(invite.code));
  assert.ok(!JSON.stringify(records).includes(guest.ice[0].credential));
});

test('debug runs accept private TURN configuration in normal iceServers format', () => {
  const turn = { urls: ['turns:relay.example.net:443?transport=tcp'], username: 'user', credential: 'test' };
  assert.deepEqual(configuredTurn({ iceServers: [{ urls: 'stun:stun.example.net' }, turn] }), [turn]);
  assert.throws(() => configuredTurn([{ urls: 'turn:relay.example.net' }]), /authenticated TURN/);
});
