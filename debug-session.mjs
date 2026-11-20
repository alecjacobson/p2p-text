import { mkdir } from 'node:fs/promises';
import { directory, diagnosticFile } from './diagnostics.mjs';
import { configuredTurn, iceFile, loadStationKeys, newRun, readSettings, runFile, saveSettings, stationLinks } from './debug-stations.mjs';

const [action, argument] = process.argv.slice(2);
await mkdir(directory, { recursive: true, mode: 0o700 });

if (action === 'links') {
  const links = stationLinks(await loadStationKeys(), argument);
  console.log(`First browser ${links.invite}\nSecond browser ${links.join}`);
} else if (action === 'run') {
  if (!await readSettings(new URL('stations.json', directory))) throw new Error('Create station links first.');
  const run = newRun(argument ?? 'direct');
  if (run.mode === 'turn') run.ice = configuredTurn(await readSettings(iceFile));
  await saveSettings(runFile, run);
  console.log(`Queued ${run.mode} test ${run.id.slice(0, 8)} for ten minutes. Logs go to ${diagnosticFile.pathname}.`);
} else {
  console.log('node debug-session.mjs links [url] or run [lan|direct|turn]');
}
