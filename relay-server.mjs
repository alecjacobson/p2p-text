import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { signalHandler } from './signal.mjs';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8787' }
  }
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');

const app = (await readFile(new URL('./dist/index.html', import.meta.url), 'utf8'))
  .replace('</head>', '<meta name="short-overleaf-relay" content="/api/signal"></head>');
const handleSignal = signalHandler();

createServer({ requestTimeout: 10000 }, (request, response) => {
  if (request.url === '/api/signal') return handleSignal(request, response);
  if (request.method === 'GET' && ['/', '/index.html'].includes(request.url)) {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    return response.end(app);
  }
  response.writeHead(404).end();
}).listen(port, values.host, () => {
  console.log(`Short Overleaf with six-character pairing is available at http://${values.host}:${port}`);
  console.log('For another machine, open the same HTTPS relay URL on both devices.');
});
