import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { branch, GitBackup } from './git-backup.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    push: { type: 'boolean', default: false },
    port: { type: 'string', default: '4173' }
  }
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');
if (values.push && !values.repo) throw new Error('--push requires --repo.');
const host = `127.0.0.1:${port}`;
const origin = `http://${host}`;
const html = await readFile(new URL('./dist/index.html', import.meta.url));
const backup = values.repo ? new GitBackup(resolve(values.repo), values.push) : null;
await backup?.check();

const bodyLimit = 2 * 1024 * 1024;
function json(response, code, payload) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  if (Number(request.headers['content-length']) > bodyLimit) throw new Error('Snapshot is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) throw new Error('Snapshot is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.headers.host !== host) return json(response, 403, { error: 'Expected loopback host.' });
  if (request.method === 'GET' && ['/', '/index.html'].includes(request.url)) {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
    });
    return response.end(html);
  }
  if (request.url !== '/api/backup') return json(response, 404, { error: 'Unknown path.' });
  if (request.method === 'GET') return json(response, 200, { enabled: Boolean(backup), branch, push: values.push });
  if (request.method !== 'POST') return json(response, 405, { error: 'Expected POST.' });
  if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
    return json(response, 403, { error: 'Expected a same-origin snapshot.' });
  }
  if (!backup) return json(response, 403, { error: 'Git backup is disabled.' });

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    const tooLarge = error.message === 'Snapshot is too large.';
    return json(response, tooLarge ? 413 : 400, { error: tooLarge ? error.message : 'Invalid snapshot JSON.' });
  }
  try {
    const commit = await backup.write(body?.doc, body?.content);
    json(response, 200, { commit });
  } catch (error) {
    json(response, 409, { error: error.message });
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Short Overleaf is available at ${origin}`);
});
