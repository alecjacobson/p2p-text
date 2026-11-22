import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadIceConfiguration } from '../ice-config.mjs';
import { defaultStun, iceConfiguration, iceMetadata } from '../src/ice.js';

const turn = { urls: ['turns:relay.example.org:443?transport=tcp', 'turn:relay.example.org:3478?transport=udp'], username: 'temporary-user', credential: 'temporary-password' };

test('hosted ICE settings preserve all TURN transports and prefer direct routes by default', () => {
  const config = iceConfiguration({ iceServers: [{ urls: defaultStun }, turn] });
  assert.equal(config.iceTransportPolicy, 'all');
  assert.deepEqual(config.iceServers[1], turn);
  assert.deepEqual(config.iceServers[0], { urls: [defaultStun] });
  assert.equal(iceConfiguration({ iceServers: [turn], iceTransportPolicy: 'relay' }).iceTransportPolicy, 'relay');
});

test('relay-only mode cannot silently run without TURN and invalid values do not leak secrets', () => {
  assert.throws(() => iceConfiguration({ iceServers: [], iceTransportPolicy: 'relay' }), /authenticated TURN/);
  assert.throws(() => iceConfiguration({ iceServers: [turn], iceTransportPolicy: 'invalid' }), /transport policy/);
  assert.throws(() => iceConfiguration({ iceServers: [{ urls: 'turn:example.org', credential: 'SECRET' }] }), /username/);
  assert.throws(() => iceConfiguration({ iceServers: [{ urls: 'https://user:SECRET@example.org' }] }), error => !error.message.includes('SECRET'));
  assert.throws(() => iceConfiguration({ iceServers: Array(9).fill(turn) }), /eight/);
  assert.deepEqual(iceConfiguration({ iceServers: [] }), { iceServers: [], iceTransportPolicy: 'all' });
});

test('embedding shared configuration cannot inject HTML and round-trips credentials', () => {
  const config = iceConfiguration({ iceServers: [{ ...turn, credential: '\"</head><script>alert(1)</script>&' }] });
  const html = iceMetadata(config);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('</head>'));
  const encoded = html.match(/content="([^"]+)"/)[1];
  assert.deepEqual(iceConfiguration(JSON.parse(decodeURIComponent(encoded))), config);
  assert.equal(iceMetadata(undefined), '');
});

test('operator JSON is validated before relay startup and parse errors omit credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p2p-ice-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ice.json');
  await writeFile(path, JSON.stringify({ iceServers: [turn] }));
  assert.deepEqual((await loadIceConfiguration(path)).iceServers, [turn]);
  await writeFile(path, '{"credential":"SECRET"');
  await assert.rejects(() => loadIceConfiguration(path), error => !error.message.includes('SECRET'));
  assert.equal(await loadIceConfiguration(undefined), undefined);
});
