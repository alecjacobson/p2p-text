import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';

const profile = process.env.SHORT_OVERLEAF_DEBUG_PROFILE;
if (profile && !/^[a-z0-9-]+$/.test(profile)) throw new Error('Invalid diagnostic profile.');
export const directory = new URL(profile ? `./.p2p-debug/${profile}/` : './.p2p-debug/', import.meta.url);
export const diagnosticFile = new URL('events.ndjson', directory);
const candidateTypes = ['host', 'srflx', 'prflx', 'relay'];
const phases = ['new', 'checking', 'connecting', 'connected', 'completed', 'disconnected', 'failed', 'closed'];

const fields = {
  configured: { stun: Boolean, turn: Boolean, browser: ['chromium', 'firefox', 'webkit', 'other'] },
  state: {
    gathering: ['new', 'gathering', 'complete'],
    ice: phases,
    state: phases,
    signaling: ['stable', 'have-local-offer', 'have-remote-offer', 'closed']
  },
  candidate: { candidate: candidateTypes, protocol: ['udp', 'tcp'] },
  'candidate-error': { code: Number, scheme: ['stun', 'stuns', 'turn', 'turns'] },
  'local-description': { host: Number, hostMdns: Number, srflx: Number, relay: Number },
  'remote-description': { host: Number, hostMdns: Number, srflx: Number, relay: Number },
  'channel-open': {},
  'channel-close': {},
  'update-received': {},
  'test-greeting-confirmed': {},
  timeout: {},
  closed: {},
  stats: {
    pairs: Number, succeeded: Number, requests: Number, responses: Number,
    localHost: Number, remoteHost: Number, localRelay: Number, remoteRelay: Number,
    local: candidateTypes, remote: candidateTypes
  },
  'stats-unavailable': {},
  error: {
    reason: ['no-ice-candidates'],
    name: ['Error', 'TypeError', 'SyntaxError', 'InvalidStateError', 'InvalidAccessError',
      'NotSupportedError', 'OperationError', 'RTCError', 'AbortError']
  }
};

export function sanitizeDiagnostic(input) {
  if (!input || typeof input !== 'object') return null;
  const { event, role, attempt, peer } = input;
  if (typeof event !== 'string' || !Object.hasOwn(fields, event) ||
      !['invite', 'join'].includes(role) || typeof attempt !== 'string' ||
      typeof peer !== 'string' || !/^[\da-f]{8}$/.test(attempt) || !/^[\da-f]{8}$/.test(peer)) return null;
  const record = { source: 'browser', event, role, attempt, peer };
  for (const [key, rule] of Object.entries(fields[event])) {
    const value = input[key];
    const valid = rule === Boolean ? typeof value === 'boolean'
      : rule === Number ? Number.isInteger(value) && value >= 0 && value <= 1000000
      : rule.includes(value);
    if (valid) record[key] = value;
  }
  return record;
}

export function diagnosticHandler(write) {
  return debugJsonHandler(async input => {
    const record = sanitizeDiagnostic(input);
    if (!record) return { status: 400 };
    write(record);
    return { status: 204 };
  });
}

export function debugJsonHandler(process) {
  return async (request, response) => {
    function end(status, payload) {
      response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
      response.end(payload === undefined ? undefined : JSON.stringify(payload));
    }
    if (request.method !== 'POST') return end(405);
    if (request.headers['content-type'] !== 'application/json') return end(415);
    try {
      if (new URL(request.headers.origin).host !== request.headers.host) return end(403);
    } catch {
      return end(403);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 4096) {
          request.resume();
          return end(413);
        }
        chunks.push(chunk);
      }
      const { status, payload } = await process(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return end(status, payload);
    } catch {
      return end(400);
    }
  };
}

export async function startDiagnostics() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = (await open(diagnosticFile, 'a', 0o600)).createWriteStream();
  const session = randomUUID().slice(0, 8);
  let remaining = 4000;
  let available = true;
  log.on('error', error => {
    available = false;
    console.error('Could not write diagnostic log', error.message);
  });

  function write(event) {
    if (!available || remaining <= 0) return;
    remaining--;
    log.write(JSON.stringify({ time: new Date().toISOString(), session, ...event }) + '\n');
  }

  return { write, handle: diagnosticHandler(write) };
}
