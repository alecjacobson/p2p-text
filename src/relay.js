export const codeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const shortCodePattern = new RegExp(`^[${codeAlphabet}]{6}$`);

export function shortCode(input) {
  const candidate = input.trim().toUpperCase();
  return shortCodePattern.test(candidate) ? candidate : '';
}

export function relayEndpoint(value) {
  if (!value.trim()) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter the full signaling endpoint URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.hash || url.search) {
    throw new Error('The signaling endpoint requires HTTPS outside localhost.');
  }
  return url.href;
}

export async function callRelay(endpoint, action, fields) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...fields }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    throw new Error('Could not reach the signaling relay.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error ?? 'The signaling relay returned an invalid response.');
    error.status = response.status;
    throw error;
  }
  return result;
}
