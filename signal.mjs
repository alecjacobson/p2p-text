import { randomBytes, randomUUID } from 'node:crypto';
import { readCode } from './src/peer.js';
import { codeAlphabet, shortCode } from './src/relay.js';

const maxSignalBytes = 32 * 1024;
const requestLimit = 40 * 1024;
const maxInvites = 300;
const limitWindow = 60 * 1000;

class SignalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class SignalMailbox {
  #invites = new Map();
  #clients = new Map();
  #windowEnds = 0;
  #transactions = 0;

  process(body, address) {
    const now = Date.now();
    if (now >= this.#windowEnds) {
      this.#windowEnds = now + limitWindow;
      this.#transactions = 0;
      this.#clients.clear();
      for (const [code, invite] of this.#invites) {
        if (invite.expires <= now) this.#invites.delete(code);
      }
    }

    const { action, owner, guest } = body ?? {};
    if (action === 'create' || action === 'claim') {
      const count = this.#clients.get(address) ?? 0;
      if (count >= 20 || this.#transactions >= 600) {
        throw new SignalError(429, 'Too many pairing requests. Try again in a minute.');
      }
      this.#transactions++;
      this.#clients.set(address, count + 1);
    }

    if (action === 'create') {
      const offer = this.#decode(body.offer, 'offer');
      if (this.#invites.size >= maxInvites) throw new SignalError(503, 'The signaling relay is full. Try again soon.');
      let code;
      do {
        code = Array.from(randomBytes(6), byte => codeAlphabet[byte % codeAlphabet.length]).join('');
      } while (this.#invites.has(code));
      const key = randomUUID();
      this.#invites.set(code, { offer: body.offer, owner: key, expires: offer.expires });
      return { code, owner: key };
    }

    const code = typeof body?.code === 'string' ? shortCode(body.code) : '';
    const invite = this.#invites.get(code);
    if (!invite || invite.expires <= now) throw new SignalError(404, 'This invite has expired or does not exist.');

    switch (action) {
      case 'claim':
        if (invite.guest) throw new SignalError(409, 'This code has already been used. Ask for a new invite.');
        invite.guest = randomUUID();
        return { offer: invite.offer, guest: invite.guest };
      case 'answer': {
        if (!invite.guest || guest !== invite.guest) throw new SignalError(403, 'This client did not claim the invite.');
        if (invite.answer) throw new SignalError(409, 'The reply has already been submitted.');
        const answer = this.#decode(body.answer, 'answer');
        const offer = this.#decode(invite.offer, 'offer');
        if (offer.doc !== answer.doc || offer.invite !== answer.invite || offer.expires !== answer.expires ||
            offer.peer === answer.peer) throw new SignalError(400, 'This reply does not match the invite.');
        invite.answer = body.answer;
        return {};
      }
      case 'poll':
      case 'finish':
        if (owner !== invite.owner) throw new SignalError(403, 'This client did not create the invite.');
        if (action === 'finish') {
          this.#invites.delete(code);
          return {};
        }
        return { answer: invite.answer ?? null };
      default:
        throw new SignalError(400, 'Unknown signaling action.');
    }
  }

  #decode(value, type) {
    if (typeof value !== 'string' || value.length > maxSignalBytes) {
      throw new SignalError(400, 'Invalid or oversized signaling data.');
    }
    try {
      return readCode(value, type);
    } catch (error) {
      throw new SignalError(400, error.message);
    }
  }
}

export function signalHandler(mailbox = new SignalMailbox()) {
  return async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return;
    }

    function reply(status, payload) {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    }

    if (request.method !== 'POST') {
      reply(405, { error: 'Expected POST.' });
      return;
    }
    if (request.headers['content-type'] !== 'application/json') {
      reply(415, { error: 'Expected JSON.' });
      return;
    }

    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of request) {
        total += chunk.length;
        if (total > requestLimit) {
          reply(413, { error: 'Signaling request is too large.' });
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      reply(200, mailbox.process(body, request.socket.remoteAddress));
    } catch (error) {
      if (error instanceof SignalError) reply(error.status, { error: error.message });
      else reply(400, { error: 'Invalid signaling request.' });
    }
  };
}
