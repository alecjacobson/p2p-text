import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { directory, debugJsonHandler } from './diagnostics.mjs';
import { diagnosticAttempt } from './src/rtc-diagnostics.js';
import { iceConfiguration } from './src/ice.js';
import { isLoopbackHost, shortCode } from './src/relay.js';

export const stationFile = new URL('stations.json', directory);
export const runFile = new URL('run.json', directory);
export const iceFile = new URL('ice.json', directory);

export function newStationKeys() {
  return Object.fromEntries(['invite', 'join'].map(role => [role, randomBytes(16).toString('hex')]));
}

export function newRun(mode) {
  if (!['lan', 'direct', 'turn'].includes(mode)) throw new Error('Choose lan, direct, or turn.');
  return { id: randomUUID(), mode, expires: Date.now() + 600000 };
}

export function configuredTurn(input) {
  const { iceServers } = iceConfiguration(Array.isArray(input) ? { iceServers: input } : input);
  const turn = iceServers.filter(server => server.urls.some(url => /^turns?:/i.test(url)));
  if (!turn.length) throw new Error('Expected at least one authenticated TURN server.');
  return turn;
}

export async function readSettings(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveSettings(file, data) {
  const temporary = new URL('.' + randomUUID(), directory);
  await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export async function loadStationKeys() {
  const stored = await readSettings(stationFile);
  if (stored) return stored;
  const keys = newStationKeys();
  await saveSettings(stationFile, keys);
  return keys;
}

export function stationLinks(keys, origin) {
  const site = origin ? new URL(origin) : undefined;
  if (site && site.protocol !== 'https:' &&
      !(site.protocol === 'http:' && isLoopbackHost(site.hostname))) {
    throw new Error('Use a shared HTTPS address or localhost.');
  }
  return Object.fromEntries(Object.entries(keys).map(([role, key]) => {
    const fragment = `#station=${key}`;
    return [role, site ? new URL(fragment, site).href : fragment];
  }));
}

export function createStations(report, loadKeys, loadRun, defaultTurn) {
  const seen = new Map();
  let active;
  return async input => {
    if (!input || typeof input.key !== 'string' || !/^[a-f0-9]{32}$/.test(input.key)) return { status: 403 };
    const keys = await loadKeys();
    const role = keys?.invite === input.key ? 'invite' : keys?.join === input.key ? 'join' : '';
    if (!role) return { status: 403 };
    if (!['poll', 'publish'].includes(input.action) || typeof input.client !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(input.client)) return { status: 400 };

    const now = Date.now();
    const previous = seen.get(role);
    if (previous && previous.client !== input.client && now - previous.at <= 10000) {
      return { status: 200, payload: { role, standby: true } };
    }
    if (now - (previous?.at ?? 0) > 10000) report({ source: 'station', event: 'ready', role });
    seen.set(role, { client: input.client, at: now });
    const run = await loadRun();
    if (!run || run.expires <= now) return { status: 200, payload: { role } };
    const attempt = diagnosticAttempt(run.id);
    if (run.id !== active?.id) {
      active = { id: run.id };
      report({ source: 'station', event: 'queued', attempt, mode: run.mode });
    }

    if (input.action === 'publish') {
      const code = typeof input.code === 'string' && shortCode(input.code);
      if (role !== 'invite' || input.id !== run.id || !code || active.code) return { status: 409 };
      active.code = code;
      report({ source: 'station', event: 'auto-join-ready', attempt });
      return { status: 200, payload: { role } };
    }

    const other = role === 'invite' ? 'join' : 'invite';
    if (now - (seen.get(other)?.at ?? 0) > 10000 ||
        (role === 'join' && !active.code) || (role === 'invite' && active.code)) {
      return { status: 200, payload: { role } };
    }
    let ice = [];
    if (run.mode === 'turn') {
      ice = run.ice ?? defaultTurn;
      if (!ice) return { status: 503 };
    }
    if (run.mode === 'direct') ice = [{ urls: 'stun:stun.l.google.com:19302' }];
    return { status: 200, payload: { role, task: { id: run.id, mode: run.mode, code: active.code, ice } } };
  };
}

export function stationHandler(report, defaultTurn) {
  return debugJsonHandler(createStations(report, () => readSettings(stationFile), () => readSettings(runFile), defaultTurn));
}
