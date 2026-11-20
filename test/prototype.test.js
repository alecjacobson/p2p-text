import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { branch, GitBackup } from '../git-backup.mjs';
import { IdleBackup } from '../src/backup.js';
import { remapOffset, TextReplica, validOperations } from '../src/crdt.js';
import { carryUpdates, encodeCode, makeOffer, readCode } from '../src/peer.js';

const run = promisify(execFile);
const set = (replica, text, start) => replica.replace(replica.view().nodes, text, start);

test('concurrent edits converge through duplicate and out-of-order delivery', () => {
  const first = new TextReplica();
  const second = new TextReplica();
  const third = new TextReplica();
  const initial = set(first, 'ab🙂d');
  second.apply(initial);
  const left = set(first, 'a!b🙂d');
  const right = set(second, 'ab世界d');
  first.apply(right);
  second.apply(left);
  const merged = [...left, ...right, ...initial].reverse();
  assert.ok(validOperations(merged));
  third.apply([...merged, ...merged]);
  assert.equal(first.view().text, 'a!b世界d');
  assert.equal(second.view().text, first.view().text);
  assert.equal(third.view().text, first.view().text);
});

test('deletions survive missing anchors and preserve later edits', () => {
  const first = new TextReplica();
  const copy = new TextReplica();
  const initial = set(first, 'aaaa');
  const [target] = first.view().nodes.slice(1);
  const deletion = set(first, 'aaa', 1);
  assert.deepEqual(deletion[0][2], [target.id]);
  const insertion = set(first, 'aa🙂a', 2);
  copy.apply(deletion);
  copy.apply(insertion);
  assert.equal(copy.view().text, '');
  copy.apply(initial);
  assert.equal(copy.view().text, 'aa🙂a');
});

test('a remote insertion remaps the caret by character identity', () => {
  const replica = new TextReplica();
  set(replica, 'a🙂b');
  const old = replica.view();
  set(replica, 'xa🙂b');
  assert.equal(remapOffset(3, old.nodes, replica.view()), 4);
});

test('invite codes round-trip and reject a mismatched type or expired invite', () => {
  const signal = makeOffer(crypto.randomUUID(), crypto.randomUUID(), 'v=0\r\n');
  assert.deepEqual(readCode(encodeCode(signal), 'offer'), signal);
  assert.throws(() => readCode(encodeCode(signal), 'answer'), /reply code/);
  assert.throws(() => readCode(encodeCode({ ...signal, expires: 1 }), 'offer'), /expired/);
});

test('data channel framing reassembles a snapshot larger than a single frame', () => {
  class Channel extends EventTarget {
    readyState = 'open';
    bufferedAmount = 0;
    sent = [];
    send(frame) { this.sent.push(frame.buffer); }
  }

  const doc = crypto.randomUUID();
  const outgoing = new Channel();
  const incoming = new Channel();
  const fail = message => assert.fail(message);
  const replica = new TextReplica();
  const operations = set(replica, '🙂'.repeat(17000));
  const received = [];
  carryUpdates(incoming, doc, updates => received.push(...updates), fail);
  carryUpdates(outgoing, doc, fail, fail)(operations);
  assert.ok(outgoing.sent.length > 1);
  for (const frame of outgoing.sent) incoming.dispatchEvent(new MessageEvent('message', { data: frame }));
  assert.deepEqual(received, operations);
});

test('backup batches edits during a pause and skips already-saved text', async () => {
  const copies = [];
  const job = new IdleBackup(async content => { copies.push(content); }, () => {}, 40);
  job.enable(true);
  job.update('a');
  job.update('ab');
  job.update('abc');
  assert.deepEqual(copies, []);
  await sleep(65);
  assert.deepEqual(copies, ['abc']);
  job.update('abc');
  await sleep(50);
  assert.deepEqual(copies, ['abc']);
  job.enable(false);
});

test('Git checkpoints preserve uncommitted work, skip identical text, and push a dedicated branch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'short-overleaf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'working');
  const remote = join(directory, 'remote.git');
  const git = (cwd, ...args) => run('git', args, { cwd });
  const status = async () => (await git(repo, 'status', '--porcelain')).stdout;
  await git(directory, 'init', '--bare', remote);
  await git(directory, 'init', repo);
  await git(repo, 'config', 'user.name', 'Backup Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'remote', 'add', 'origin', remote);
  await writeFile(join(repo, 'working.txt'), 'private uncommitted work');
  await git(repo, 'add', 'working.txt');
  const before = await status();
  const helper = new GitBackup(repo, true);
  await helper.check();
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const first = await helper.write(firstId, 'first\n');
  assert.equal(await helper.write(firstId, 'first\n'), first);
  await Promise.all([helper.write(firstId, 'second\n'), helper.write(secondId, 'different doc')]);
  const show = async id => (await git(remote, 'show', `${branch}:documents/${id}.txt`)).stdout;
  assert.equal(await show(firstId), 'second\n');
  assert.equal(await show(secondId), 'different doc');
  assert.equal(await status(), before);
  assert.equal((await git(remote, 'rev-list', '--count', branch)).stdout.trim(), '3');

  const other = join(directory, 'other');
  await git(directory, 'clone', remote, other);
  await git(other, 'config', 'user.name', 'Backup Test');
  await git(other, 'config', 'user.email', 'test@example.invalid');
  await new GitBackup(other, true).write(firstId, 'third\n');
  assert.equal(await show(firstId), 'third\n');
  assert.equal(await show(secondId), 'different doc');
});
