import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { diagnosticFile, startDiagnostics } from './diagnostics.mjs';
import { stationHandler } from './debug-stations.mjs';
import { SignalMailbox, signalHandler } from './signal.mjs';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8787' },
    debug: { type: 'boolean', default: false }
  }
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port.');
const diagnostics = values.debug ? await startDiagnostics() : undefined;
const metadata = '<meta name="short-overleaf-relay" content="/api/signal">' +
  (diagnostics ? '<meta name="short-overleaf-diagnostics" content="/api/diagnostics">' : '');
const app = (await readFile(new URL('./dist/index.html', import.meta.url), 'utf8'))
  .replace('</head>', metadata + '</head>');
const handleSignal = signalHandler(new SignalMailbox(diagnostics?.write));
const handleStation = diagnostics && stationHandler(diagnostics.write);

const server = createServer({ requestTimeout: 10000 }, (request, response) => {
  if (request.url === '/api/signal') return handleSignal(request, response);
  if (diagnostics && request.url === '/api/diagnostics') return diagnostics.handle(request, response);
  if (handleStation && request.url === '/api/debug-station') return handleStation(request, response);
  if (request.method === 'GET' && ['/', '/index.html'].includes(request.url)) {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    return response.end(app);
  }
  response.writeHead(404).end();
});
server.once('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Stop the existing Node relay and run this command again.`
    : error.message);
  process.exitCode = 1;
});
server.listen(port, values.host, () => {
  console.log(`Short Overleaf with six-character pairing is available at http://${values.host}:${port}`);
  console.log('For another machine, open the same HTTPS relay URL on both devices.');
  if (diagnostics) {
    diagnostics.write({ source: 'relay', event: 'started' });
    console.log(`Connection diagnostics are enabled at ${fileURLToPath(diagnosticFile)}`);
  }
});
