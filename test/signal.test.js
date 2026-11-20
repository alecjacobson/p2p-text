import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { SignalMailbox, signalHandler } from '../signal.mjs';
import { encodeCode, makeOffer } from '../src/peer.js';
import { shortCode } from '../src/relay.js';

const sender = '192.0.2.1';
const receiver = '192.0.2.2';
const makeInvite = () => makeOffer(crypto.randomUUID(), crypto.randomUUID(), 'v=0\r\n');

test('a six-character invite hands off one offer and one reply', () => {
  const mailbox = new SignalMailbox();
  const signal = makeInvite();
  const offer = encodeCode(signal);
  const answer = encodeCode({ ...signal, type: 'answer', peer: crypto.randomUUID() });
  const { code, owner } = mailbox.process({ action: 'create', offer }, sender);
  assert.equal(shortCode(code), code);
  assert.equal(code.length, 6);
  assert.deepEqual(mailbox.process({ action: 'poll', code, owner }, sender), { answer: null });

  const claimed = mailbox.process({ action: 'claim', code: code.toLowerCase() }, receiver);
  assert.equal(claimed.offer, offer);
  assert.throws(() => mailbox.process({ action: 'claim', code }, receiver), { status: 409 });
  assert.throws(() => mailbox.process({ action: 'answer', code, answer }, receiver), { status: 403 });
  assert.throws(() => mailbox.process({ action: 'poll', code }, receiver), { status: 403 });
  const wrongAnswer = encodeCode({ ...signal, doc: crypto.randomUUID(), type: 'answer', peer: crypto.randomUUID() });
  assert.throws(() => mailbox.process({
    action: 'answer', code, guest: claimed.guest, answer: wrongAnswer
  }, receiver), { status: 400 });

  mailbox.process({ action: 'answer', code, guest: claimed.guest, answer }, receiver);
  assert.deepEqual(mailbox.process({ action: 'poll', code, owner }, sender), { answer });
  mailbox.process({ action: 'finish', code, owner }, sender);
  assert.throws(() => mailbox.process({ action: 'claim', code }, receiver), { status: 404 });
});

test('short codes expire and repeated lookups are rate-limited', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const mailbox = new SignalMailbox();
  const offer = encodeCode({ ...makeInvite(), expires: now + 10 });
  const { code } = mailbox.process({ action: 'create', offer }, sender);
  Date.now.mock.mockImplementation(() => now + 11);
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.throws(() => mailbox.process({ action: 'claim', code }, receiver), { status: 404 });
  }
  assert.throws(() => mailbox.process({ action: 'claim', code }, receiver), { status: 429 });
});

test('HTTP signaling handler accepts JSON and supports cross-origin preflight', async () => {
  const handle = signalHandler();
  async function request(method, payload) {
    const body = payload ? [Buffer.from(JSON.stringify(payload))] : [];
    const incoming = Object.assign(Readable.from(body), {
      method, socket: { remoteAddress: sender }, headers: { 'content-type': 'application/json' }
    });
    const result = { headers: {}, status: 0, body: null };
    await handle(incoming, {
      setHeader(name, value) { result.headers[name] = value; },
      writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); },
      end(value) { result.body = value ? JSON.parse(value) : null; }
    });
    return result;
  }

  const preflight = await request('OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], '*');
  const created = await request('POST', { action: 'create', offer: encodeCode(makeInvite()) });
  assert.equal(created.status, 200);
  assert.equal(shortCode(created.body.code), created.body.code);
});
