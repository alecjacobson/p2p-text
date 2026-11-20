import { validDocumentId, validOperations } from './crdt.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const prefix = 'so1.';
const codeLimit = 131072;
const inviteLifetime = 15 * 60 * 1000;
const maxMessage = 8 * 1024 * 1024;
const chunkSize = 16 * 1024 - 5;
const maxBuffered = 256 * 1024;

export function encodeCode(signal) {
  const bytes = encoder.encode(JSON.stringify(signal));
  return prefix + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function readCode(input, type) {
  const code = typeof input === 'string' ? input.replace(/\s/g, '') : '';
  if (!code.startsWith(prefix) || code.length > codeLimit || !/^[\w-]+$/.test(code.slice(prefix.length))) {
    throw new Error('Paste a complete Short Overleaf code.');
  }
  let signal;
  try {
    const binary = atob(code.slice(prefix.length).replaceAll('-', '+').replaceAll('_', '/'));
    signal = JSON.parse(decoder.decode(Uint8Array.from(binary, character => character.charCodeAt(0))));
  } catch {
    throw new Error('This code could not be decoded.');
  }
  if (signal?.type !== type || !validDocumentId(signal.doc) ||
      !validDocumentId(signal.invite) || !validDocumentId(signal.peer) ||
      typeof signal.sdp !== 'string' || !signal.sdp.startsWith('v=0') ||
      !Number.isSafeInteger(signal.expires) || signal.expires > Date.now() + inviteLifetime + 60000) {
    throw new Error(`Paste a valid ${type === 'offer' ? 'invite' : 'reply'} code.`);
  }
  if (signal.expires <= Date.now()) throw new Error('This code has expired. Create a fresh invite.');
  return signal;
}

export function makeOffer(doc, peer, sdp, invite = crypto.randomUUID()) {
  return { type: 'offer', doc, peer, sdp, invite, expires: Date.now() + inviteLifetime };
}

export function hasIceCandidates(sdp) {
  return /(?:^|\n)a=candidate:/.test(sdp ?? '');
}

export async function gather(connection, type) {
  await connection.setLocalDescription(
    await (type === 'offer' ? connection.createOffer() : connection.createAnswer())
  );
  if (connection.iceGatheringState !== 'complete') {
    await new Promise(resolve => {
      const timeout = setTimeout(finish, 10000);
      function finish() {
        clearTimeout(timeout);
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
      function check() {
        if (connection.iceGatheringState === 'complete' || connection.signalingState === 'closed') finish();
      }
      connection.addEventListener('icegatheringstatechange', check);
      check();
    });
  }
  const description = connection.localDescription;
  // The offerer can learn the responder's address from an inbound ICE check
  // even when the answer advertises no candidates.
  const canDiscoverFromOffer = type === 'answer' && hasIceCandidates(connection.remoteDescription?.sdp);
  if (!description?.sdp || (!hasIceCandidates(description.sdp) && !canDiscoverFromOffer)) {
    const error = new Error('No ICE candidates were gathered. Check your network or ICE settings.');
    error.code = 'no-ice-candidates';
    throw error;
  }
  return description.sdp;
}

// Ordered SCTP frames keep snapshots below browsers' per-message limits.
export function carryUpdates(channel, doc, onUpdates, onFailure) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = maxBuffered / 2;
  let queue = [];
  let queuedBytes = 0;
  let offset = 0;
  let received;
  let receivedBytes = 0;

  function pump() {
    try {
      while (queue.length && channel.readyState === 'open' && channel.bufferedAmount < maxBuffered) {
        const bytes = queue[0];
        const chunk = bytes.subarray(offset, offset + chunkSize);
        const frame = new Uint8Array(chunk.length + 4);
        new DataView(frame.buffer).setUint32(0, offset === 0 ? bytes.length : 0);
        frame.set(chunk, 4);
        channel.send(frame);
        offset += chunk.length;
        if (offset === bytes.length) {
          queue.shift();
          queuedBytes -= bytes.length;
          offset = 0;
        }
      }
    } catch (error) {
      onFailure(error.message);
    }
  }

  channel.addEventListener('bufferedamountlow', pump);
  channel.addEventListener('close', () => {
    queue = [];
    queuedBytes = 0;
    received = undefined;
  });
  channel.addEventListener('message', event => {
    try {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength <= 4 ||
          event.data.byteLength > chunkSize + 4) throw new Error('Invalid peer frame.');
      const length = new DataView(event.data).getUint32(0);
      if (length) {
        if (received || length > maxMessage) throw new Error('Peer update exceeds the frame limit.');
        received = new Uint8Array(length);
        receivedBytes = 0;
      }
      const chunk = new Uint8Array(event.data, 4);
      if (!received || receivedBytes + chunk.length > received.length) throw new Error('Incomplete peer frame.');
      received.set(chunk, receivedBytes);
      receivedBytes += chunk.length;
      if (receivedBytes !== received.length) return;
      const payload = JSON.parse(decoder.decode(received));
      received = undefined;
      if (payload?.doc !== doc || !validOperations(payload.operations)) throw new Error('Invalid document update.');
      onUpdates(payload.operations);
    } catch (error) {
      onFailure(error.message);
    }
  });

  return operations => {
    if (!operations.length || channel.readyState !== 'open') return;
    const bytes = encoder.encode(JSON.stringify({ doc, operations }));
    if (bytes.length > maxMessage || queuedBytes + bytes.length > 2 * maxMessage) {
      onFailure('The document or queued updates exceed the peer sync limit.');
      return;
    }
    queue.push(bytes);
    queuedBytes += bytes.length;
    pump();
  };
}
