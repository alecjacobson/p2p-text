import { readFile } from 'node:fs/promises';
import { iceConfiguration } from './src/ice.js';

export async function loadIceConfiguration(path) {
  if (!path) return undefined;
  let input;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Could not load ICE configuration. Provide a readable JSON file with an iceServers list.');
  }
  return iceConfiguration(input);
}
