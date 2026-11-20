import { TextReplica, remapOffset, validDocumentId, validOperations } from './crdt.js';
import { carryUpdates, encodeCode, gather, makeOffer, readCode } from './peer.js';
import { IdleBackup } from './backup.js';
import { callRelay, inviteFromFragment, isLoopbackHost, relayEndpoint, shareableJoinLink, shortCode } from './relay.js';

const byId = id => document.getElementById(id);
const editor = byId('editor');
const docs = byId('documents');
const relayField = byId('relay-url');
const defaultRelay = document.querySelector('meta[name="short-overleaf-relay"]')?.content;
if (defaultRelay) relayField.value = new URL(defaultRelay, location.href).href;
const peerId = crypto.randomUUID();
const storagePrefix = 'short-overleaf.doc.';
const backups = new Map();
const links = new Map();
let docId;
let replica;
let displayed;
let writeTimer;
let storageAvailable = true;
let storageError = '';
let composing = false;
let compositionTimer;
let editSelection;
let pending;
let mode = 'invite';
let busy = false;
let backupConfig;
let tabDoc;
try {
  tabDoc = sessionStorage.getItem('short-overleaf.active');
} catch {
  storageAvailable = false;
}

function readSnapshot(id) {
  try {
    return decodeSnapshot(localStorage.getItem(storagePrefix + id));
  } catch {
    storageAvailable = false;
  }
  return [];
}

function decodeSnapshot(value) {
  try {
    const operations = value ? JSON.parse(value) : [];
    return validOperations(operations) ? operations : [];
  } catch {
    return [];
  }
}

function saveLocal() {
  clearTimeout(writeTimer);
  if (!storageAvailable || !replica) return;
  const saved = readSnapshot(docId);
  acceptUpdates(saved, 'storage', false);
  if (replica.operations.size === saved.length) return;
  try {
    localStorage.setItem(storagePrefix + docId, JSON.stringify(replica.snapshot()));
    storageError = '';
  } catch {
    storageError = 'Browser storage is full or unavailable';
  }
  showLocalStatus();
}

function showLocalStatus() {
  byId('local-status').textContent = storageError || (storageAvailable ? 'Stored in this browser' : 'Browser storage unavailable');
}

function listDocuments() {
  const ids = new Set([docId]);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(storagePrefix)) {
        const id = key.slice(storagePrefix.length);
        if (validDocumentId(id)) ids.add(id);
      }
    }
  } catch {
    storageAvailable = false;
  }
  docs.replaceChildren(...[...ids].map(id => new Option(`Document ${id.slice(0, 8)}`, id)));
  docs.value = docId;
}

function switchDocument(id, keepConnection) {
  if (id === docId) return;
  if (composing && replica) {
    clearTimeout(compositionTimer);
    composing = false;
    applyEditor();
  }
  saveLocal();
  cancelPairing();
  for (const connection of [...links.keys()]) {
    if (connection !== keepConnection) closeLink(connection);
  }
  docId = id;
  replica = new TextReplica();
  replica.apply(readSnapshot(id));
  displayed = replica.view();
  editor.value = displayed.text;
  try {
    sessionStorage.setItem('short-overleaf.active', id);
  } catch {
    // The document can still be edited and shared.
  }
  listDocuments();
  showLocalStatus();
  showCounts();
  showBackup();
}

function showCounts() {
  const count = displayed.text.trim().split(/\s+/u).filter(Boolean).length;
  byId('word-count').textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
}

function paint(localEdit = false) {
  const next = replica.view();
  if (editor.value !== next.text) {
    const oldSelection = [editor.selectionStart, editor.selectionEnd, editor.selectionDirection];
    const oldScroll = editor.scrollTop;
    editor.value = next.text;
    const offsets = localEdit
      ? oldSelection.slice(0, 2)
      : oldSelection.slice(0, 2).map(offset => remapOffset(offset, displayed.nodes, next));
    editor.setSelectionRange(...offsets, oldSelection[2]);
    editor.scrollTop = oldScroll;
  }
  displayed = next;
  showCounts();
}

function changed(operations, origin, persist = true) {
  if (!operations.length) return;
  if (persist) {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(saveLocal, 250);
  }
  for (const [connection, link] of links) {
    if (origin !== connection) link.send?.(operations);
  }
  const record = backups.get(docId);
  if (record?.job.enabled) record.job.update(composing ? replica.view().text : displayed.text);
}

function acceptUpdates(operations, origin, persist = true) {
  const accepted = replica.apply(operations);
  if (!accepted.length) return;
  if (!composing) paint();
  changed(accepted, origin, persist);
}

function applyEditor() {
  if (composing) return;
  let start = editSelection?.start;
  if (editSelection?.backspace) {
    start = Math.max(0, start - Math.max(0, displayed.nodes.length - Array.from(editor.value).length));
  }
  editSelection = undefined;
  const accepted = replica.replace(displayed.nodes, editor.value, start);
  paint(true);
  changed(accepted, null);
}

editor.addEventListener('beforeinput', event => {
  if (composing || !/^(insert|delete)/.test(event.inputType)) return;
  editSelection = {
    start: Array.from(editor.value.slice(0, editor.selectionStart)).length,
    backspace: editor.selectionStart === editor.selectionEnd && event.inputType.endsWith('Backward')
  };
});
editor.addEventListener('input', applyEditor);
editor.addEventListener('compositionstart', () => {
  clearTimeout(compositionTimer);
  composing = true;
  editSelection = { start: Array.from(editor.value.slice(0, editor.selectionStart)).length };
});
editor.addEventListener('compositionend', () => {
  compositionTimer = setTimeout(() => {
    composing = false;
    applyEditor();
  }, 0);
});
docs.addEventListener('change', () => {
  switchDocument(docs.value);
  setMode('invite');
});
byId('new-document').addEventListener('click', () => {
  switchDocument(crypto.randomUUID());
  setMode('invite');
  editor.focus();
});
window.addEventListener('pagehide', saveLocal);
window.addEventListener('storage', event => {
  if (!event.key?.startsWith(storagePrefix)) return;
  if (event.key === storagePrefix + docId) acceptUpdates(decodeSnapshot(event.newValue), 'storage');
  listDocuments();
});

function message(text, error = false) {
  const element = byId('pair-message');
  element.textContent = text;
  element.classList.toggle('error', error);
}

function showRelayStatus() {
  const status = byId('relay-status');
  let endpoint;
  try {
    endpoint = relayEndpoint(relayField.value);
  } catch {
    endpoint = '';
  }
  status.hidden = !endpoint;
  if (!endpoint) return;
  const { host, hostname } = new URL(endpoint);
  status.textContent = isLoopbackHost(hostname)
    ? 'Local relay. For another machine, open the same shared HTTPS relay URL on both devices.'
    : `Signaling relay ${host}`;
}

function renderPairing() {
  const invite = mode === 'invite';
  const signal = pending?.signal;
  const relay = pending?.relay;
  const offersShortCodes = Boolean(relayField.value.trim());
  byId('invite-tab').setAttribute('aria-pressed', String(invite));
  byId('join-tab').setAttribute('aria-pressed', String(!invite));
  docs.disabled = busy;
  byId('new-document').disabled = busy;
  byId('new-invite').hidden = !invite || Boolean(pending);
  byId('new-invite').disabled = busy;
  byId('cancel-pairing').hidden = !pending;
  byId('pair-input').hidden = invite ? !signal || Boolean(relay) : Boolean(signal);
  byId('pair-output').hidden = !signal || Boolean(relay && !invite);
  relayField.disabled = busy || Boolean(pending);
  byId('incoming-label').textContent = invite ? 'Reply code' : 'Invite code';
  byId('apply-code').textContent = invite || shortCode(byId('incoming-code').value)
    ? 'Connect peer' : 'Create reply';
  byId('apply-code').disabled = busy || Boolean(pending?.used);
  byId('copy-label').textContent = invite ? 'Your invite code' : 'Your reply code';
  const output = byId('outgoing-code');
  output.value = relay?.code ?? (signal ? encodeCode(signal) : '');
  output.classList.toggle('short-code', Boolean(relay));
  const sharedLink = invite && relay ? shareableJoinLink(relay.endpoint, relay.code) : '';
  const linkField = byId('join-link');
  if (linkField.value !== sharedLink) {
    linkField.value = sharedLink;
    linkField.hidden = true;
  }
  byId('copy-join-link').hidden = !sharedLink;
  byId('pair-hint').textContent = invite
    ? relay ? 'Share this six-character code privately.'
      : signal ? 'Send the invite privately. Paste your collaborator’s reply below.'
      : offersShortCodes ? 'Generate a six-character code to share with a collaborator.'
      : 'Generate a one-time code to share with a collaborator.'
    : relay ? 'Waiting for the peer connection to open.'
      : signal ? 'Send this reply privately to finish connecting.' : 'Enter the invite your collaborator sent you.';
  showRelayStatus();
  const count = [...links.values()].filter(link => link.open).length;
  byId('connection-badge').classList.toggle('online', count > 0);
  byId('connection-label').textContent = count ? `${count} ${count === 1 ? 'peer' : 'peers'} connected` : 'Working solo';
}

function cancelPairing() {
  if (!pending) return;
  const connection = pending.connection;
  pending = undefined;
  closeLink(connection);
}

function setMode(nextMode) {
  cancelPairing();
  mode = nextMode;
  byId('incoming-code').value = '';
  message('');
  renderPairing();
}

function closeLink(connection, reason) {
  const link = links.get(connection);
  if (!link) return;
  links.delete(connection);
  clearTimeout(link.timer);
  clearTimeout(link.poll);
  if (link.relay) finishRelay(link.relay);
  if (pending?.connection === connection) pending = undefined;
  connection.close();
  if (reason) message(reason, true);
  renderPairing();
}

function expireLink(connection, delay, reason) {
  const link = links.get(connection);
  if (!link) return;
  clearTimeout(link.timer);
  link.timer = setTimeout(() => closeLink(connection, reason), Math.max(0, delay));
}

function createLink(documentId) {
  const servers = [];
  const stun = byId('stun-url').value.trim();
  const turn = byId('turn-url').value.trim();
  if (stun) servers.push({ urls: stun });
  if (turn) servers.push({ urls: turn, username: byId('turn-user').value, credential: byId('turn-key').value });
  const connection = new RTCPeerConnection({ iceServers: servers });
  const link = { open: false, timer: undefined, send: undefined };
  links.set(connection, link);

  function attach(channel) {
    if (channel.label !== 'short-overleaf') {
      channel.close();
      return;
    }
    link.send = carryUpdates(channel, documentId, operations => {
      if (docId === documentId) acceptUpdates(operations, connection);
    }, reason => closeLink(connection, reason));
    function open() {
      if (!links.has(connection) || link.open) return;
      if (docId !== documentId) {
        closeLink(connection);
        return;
      }
      link.open = true;
      clearTimeout(link.timer);
      if (pending?.connection === connection) {
        pending = undefined;
        byId('incoming-code').value = '';
      }
      message('Peer connected. Changes sync as you type.');
      link.send(replica.snapshot());
      renderPairing();
    }
    channel.addEventListener('open', open);
    channel.addEventListener('close', () => closeLink(connection, 'Peer disconnected. You can keep editing.'));
    if (channel.readyState === 'open') open();
  }

  connection.addEventListener('datachannel', event => attach(event.channel));
  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'failed') {
      closeLink(connection, 'Connection failed. Create a fresh invite or configure TURN.');
    }
  });
  return { connection, attach };
}

async function acceptReply(invitation, answer) {
  if (answer.peer === peerId) throw new Error('Share this code with a different client.');
  if (invitation?.signal.invite !== answer.invite || answer.doc !== docId ||
      invitation.signal.expires !== answer.expires || invitation.used) {
    throw new Error('This reply does not match an active, unused invite.');
  }
  await invitation.connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  invitation.used = true;
  if (links.has(invitation.connection) && !links.get(invitation.connection).open) {
    expireLink(invitation.connection, 30000, 'Connection timed out. Try a fresh invite or configure TURN.');
    message('Connecting to your peer…');
  }
}

function finishRelay({ endpoint, code, owner }) {
  callRelay(endpoint, 'finish', { code, owner }).catch(() => {
    // The relay expires abandoned invites automatically.
  });
}

async function claimShortInvite(endpoint, code) {
  try {
    return await callRelay(endpoint, 'claim', { code });
  } catch (error) {
    if (error.status !== 404) throw error;
    const { host, hostname } = new URL(endpoint);
    if (isLoopbackHost(hostname)) {
      throw new Error('No active invite on this local relay. If the invite came from another machine, open the inviter’s shared HTTPS relay link.');
    }
    throw new Error(`No active invite on ${host}. Open the inviter’s relay link or ask for a fresh code.`);
  }
}

async function waitForReply(invitation) {
  const { connection, relay } = invitation;
  const { endpoint, code, owner } = relay;
  const link = links.get(connection);
  if (!link || pending !== invitation) return;
  try {
    const { answer } = await callRelay(endpoint, 'poll', { code, owner });
    if (pending !== invitation) return;
    if (answer) {
      await acceptReply(invitation, readCode(answer, 'answer'));
      if (links.has(connection)) {
        link.relay = undefined;
        finishRelay(relay);
      }
      return;
    }
    message('Invite ready. Waiting for a peer…');
  } catch (error) {
    if (pending !== invitation) return;
    if (error.status === 404) {
      closeLink(connection, error.message);
      return;
    }
    message(error.message, true);
  }
  if (pending === invitation) link.poll = setTimeout(() => waitForReply(invitation), 1500);
}

relayField.addEventListener('input', renderPairing);
byId('incoming-code').addEventListener('input', renderPairing);
byId('invite-tab').addEventListener('click', () => { if (!busy && mode !== 'invite') setMode('invite'); });
byId('join-tab').addEventListener('click', () => { if (!busy && mode !== 'join') setMode('join'); });
byId('cancel-pairing').addEventListener('click', () => setMode(mode));
byId('new-invite').addEventListener('click', async () => {
  if (busy || pending) return;
  busy = true;
  message('Gathering connection candidates…');
  renderPairing();
  let connection;
  try {
    const endpoint = relayEndpoint(relayField.value);
    const currentDoc = docId;
    const link = createLink(currentDoc);
    connection = link.connection;
    link.attach(connection.createDataChannel('short-overleaf'));
    const sdp = await gather(connection, 'offer');
    if (!links.has(connection)) return;
    const signal = makeOffer(currentDoc, peerId, sdp);
    let relay;
    if (endpoint) {
      const { code, owner } = await callRelay(endpoint, 'create', { offer: encodeCode(signal) });
      if (typeof code !== 'string' || !shortCode(code) || typeof owner !== 'string') {
        throw new Error('The signaling relay returned an invalid invite.');
      }
      relay = { endpoint, code, owner };
      const entry = links.get(connection);
      if (!entry) {
        finishRelay(relay);
        return;
      }
      entry.relay = relay;
    }
    pending = { connection, signal, relay };
    expireLink(connection, signal.expires - Date.now(), 'Invite expired. Create a fresh invite.');
    if (relay) waitForReply(pending);
    else message('Invite ready. It expires in 15 minutes.');
  } catch (error) {
    if (connection) closeLink(connection);
    message(error.message, true);
  } finally {
    busy = false;
    renderPairing();
  }
});

byId('pair-input').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  renderPairing();
  let joining;
  try {
    const input = byId('incoming-code').value;
    if (mode === 'invite') {
      await acceptReply(pending, readCode(input, 'answer'));
    } else {
      const code = shortCode(input);
      let relay;
      let offer = input;
      if (code) {
        const endpoint = relayEndpoint(relayField.value);
        if (!endpoint) throw new Error('Set a signaling endpoint in Network settings to use a six-character code.');
        message('Looking up the invite…');
        const result = await claimShortInvite(endpoint, code);
        offer = result.offer;
        relay = { endpoint, code, guest: result.guest };
      }
      const signal = readCode(offer, 'offer');
      if (signal.peer === peerId) throw new Error('Share this code with a different client.');
      const link = createLink(signal.doc);
      joining = link.connection;
      message('Gathering connection candidates…');
      await joining.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const sdp = await gather(joining, 'answer');
      if (!links.has(joining)) return;
      if (signal.expires <= Date.now()) throw new Error('The invite expired. Ask for a fresh code.');
      switchDocument(signal.doc, joining);
      const reply = { ...signal, type: 'answer', peer: peerId, sdp };
      pending = { connection: joining, signal: reply, relay };
      expireLink(joining, signal.expires - Date.now() + 30000, 'Pairing expired. Ask for a fresh invite.');
      if (relay) {
        await callRelay(relay.endpoint, 'answer', { code, guest: relay.guest, answer: encodeCode(reply) });
        if (location.protocol === 'https:' && inviteFromFragment(location.hash) === code) {
          const page = new URL(location.href);
          page.hash = '';
          history.replaceState(history.state, '', page);
        }
        if (links.has(joining) && !links.get(joining).open) {
          expireLink(joining, 30000, 'Connection timed out. Try a fresh invite or configure TURN.');
          message('Connecting to your peer…');
        }
      } else {
        message('Reply ready. Send it back to your collaborator.');
      }
    }
  } catch (error) {
    if (joining) closeLink(joining);
    message(error.message, true);
  } finally {
    busy = false;
    renderPairing();
  }
});

byId('copy-code').addEventListener('click', async () => {
  const output = byId('outgoing-code');
  let copied = false;
  try {
    await navigator.clipboard.writeText(output.value);
    copied = true;
  } catch {
    output.select();
    copied = document.execCommand('copy');
  }
  message(copied ? 'Code copied.' : 'Code selected. Copy it with your keyboard.');
});

byId('copy-join-link').addEventListener('click', async () => {
  const field = byId('join-link');
  try {
    await navigator.clipboard.writeText(field.value);
    message('Join link copied.');
  } catch {
    field.hidden = false;
    field.focus();
    field.select();
    message('Join link selected. Copy it with your keyboard.');
  }
});

async function detectBackup() {
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return;
  try {
    const answer = await fetch('/api/backup', { cache: 'no-store' });
    if (answer.ok) backupConfig = await answer.json();
    showBackup();
  } catch {
    // A normal static server has no local backup endpoint.
  }
}

function showBackup() {
  const record = backups.get(docId);
  byId('backup-toggle').hidden = !backupConfig?.enabled;
  byId('backup-enabled').checked = Boolean(record?.job.enabled);
  byId('backup-status').textContent = record?.job.enabled
    ? record.status : backupConfig?.enabled ? 'Ready to enable' : 'Local helper required';
  byId('backup-hint').textContent = backupConfig?.enabled
    ? `Snapshots go to ${backupConfig.branch}${backupConfig.push ? ' and push to origin' : ''} after 6 seconds without edits.`
    : 'Start the app with a local Git checkout to enable automatic snapshots.';
}

byId('backup-enabled').addEventListener('change', event => {
  if (!backupConfig?.enabled) return;
  const id = docId;
  let record = backups.get(id);
  if (!record) {
    record = { status: '' };
    record.job = new IdleBackup(async content => {
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc: id, content })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Git snapshot failed.');
    }, status => {
      record.status = status;
      if (docId === id) showBackup();
    });
    backups.set(id, record);
  }
  record.job.update(replica.view().text);
  record.job.enable(event.target.checked);
  showBackup();
});

const linkedInvite = inviteFromFragment(location.hash);
if (linkedInvite) {
  mode = 'join';
  byId('incoming-code').value = linkedInvite;
}
switchDocument(validDocumentId(tabDoc) ? tabDoc : crypto.randomUUID());
renderPairing();
detectBackup();
