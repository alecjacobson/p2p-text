export function diagnosticAttempt(invite) {
  return invite.slice(0, 8);
}

export function browserFamily(userAgent) {
  if (/Chrom(e|ium)\/|Edg\//.test(userAgent)) return 'chromium';
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/Safari\//.test(userAgent)) return 'webkit';
  return 'other';
}

export function descriptionCandidates(sdp) {
  const counts = { host: 0, hostMdns: 0, srflx: 0, relay: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const [, , , , address, , , type] = line.split(/\s+/);
    if (['host', 'srflx', 'relay'].includes(type)) counts[type]++;
    if (type === 'host' && address?.endsWith('.local')) counts.hostMdns++;
  }
  return counts;
}

export function watchConnection(connection, report) {
  if (!report) return;
  for (const [event, property, field] of [
    ['icegatheringstatechange', 'iceGatheringState', 'gathering'],
    ['iceconnectionstatechange', 'iceConnectionState', 'ice'],
    ['connectionstatechange', 'connectionState', 'state'],
    ['signalingstatechange', 'signalingState', 'signaling']
  ]) {
    connection.addEventListener(event, () => report('state', { [field]: connection[property] }));
  }
  connection.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate?.candidate) {
      report('candidate', { candidate: candidate.type, protocol: candidate.protocol });
    }
  });
  connection.addEventListener('icecandidateerror', event => {
    report('candidate-error', { code: event.errorCode, scheme: event.url?.split(':')[0] });
  });
  connection.addEventListener('iceconnectionstatechange', () => {
    if (connection.iceConnectionState === 'checking') {
      setTimeout(() => {
        if (connection.iceConnectionState === 'checking') void reportIceStats(connection, report);
      }, 2000);
    }
  });
}

export async function reportIceStats(connection, report) {
  if (!report) return;
  try {
    const stats = await connection.getStats();
    const summary = {
      pairs: 0, succeeded: 0, requests: 0, responses: 0,
      localHost: 0, remoteHost: 0, localRelay: 0, remoteRelay: 0
    };
    for (const row of stats.values()) {
      if (row.type === 'candidate-pair') {
        summary.pairs++;
        if (row.state === 'succeeded') summary.succeeded++;
        summary.requests += row.requestsSent ?? 0;
        summary.responses += row.responsesReceived ?? 0;
      }
      if (row.candidateType === 'host') {
        if (row.type === 'local-candidate') summary.localHost++;
        if (row.type === 'remote-candidate') summary.remoteHost++;
      }
      if (row.candidateType === 'relay') {
        if (row.type === 'local-candidate') summary.localRelay++;
        if (row.type === 'remote-candidate') summary.remoteRelay++;
      }
      if (row.type === 'transport' && row.selectedCandidatePairId) {
        const pair = stats.get(row.selectedCandidatePairId);
        summary.local = stats.get(pair?.localCandidateId)?.candidateType;
        summary.remote = stats.get(pair?.remoteCandidateId)?.candidateType;
      }
    }
    report('stats', summary);
  } catch {
    report('stats-unavailable');
  }
}
