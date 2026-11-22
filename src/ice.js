const iceUrl = /^(stun|stuns|turn|turns):(?:[a-z\d.-]+|\[[a-f\d:.]+\])(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i;
export const defaultStun = 'stun:stun.l.google.com:19302';

export function iceConfiguration(input) {
  if (!input || !Array.isArray(input.iceServers) || input.iceServers.length > 8) {
    throw new Error('ICE settings require an iceServers list with at most eight entries.');
  }
  const policy = input.iceTransportPolicy ?? 'all';
  if (!['all', 'relay'].includes(policy)) throw new Error('ICE transport policy must be all or relay.');
  const iceServers = input.iceServers.map(server => {
    const urls = [server?.urls].flat();
    const invalidUrl = urls.some(url => {
      const match = typeof url === 'string' && url.match(iceUrl);
      return !match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535));
    });
    if (!urls.length || urls.length > 8 || invalidUrl) {
      throw new Error('Each ICE server requires valid STUN or TURN URLs.');
    }
    if (!urls.some(url => /^turns?:/i.test(url))) return { urls };
    if (typeof server.username !== 'string' || !server.username ||
        typeof server.credential !== 'string' || !server.credential) {
      throw new Error('TURN requires a username and password.');
    }
    return { urls, username: server.username, credential: server.credential };
  });
  if (policy === 'relay' && !iceServers.some(server => server.urls.some(url => /^turns?:/i.test(url)))) {
    throw new Error('Relay-only mode requires an authenticated TURN server.');
  }
  return { iceServers, iceTransportPolicy: policy };
}

export function iceMetadata(config) {
  return config ? `<meta name="short-overleaf-ice" content="${encodeURIComponent(JSON.stringify(config))}">` : '';
}
