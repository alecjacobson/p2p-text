export function runDebugStation(key, show, startTask) {
  const client = crypto.randomUUID();
  let started;
  async function request(action, fields) {
    const response = await fetch('/api/debug-station', {
      method: 'POST', mode: 'same-origin', referrerPolicy: 'origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, client, action, ...fields }),
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) {
      const error = new Error('Debug station unavailable.');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function poll() {
    try {
      const { role, task, standby } = await request('poll');
      const label = role === 'invite' ? 'First browser' : 'Second browser';
      show(standby ? `${label} is already open in another tab.` : `${label} ready for connection tests.`);
      if (task && task.id !== started) {
        const publish = code => request('publish', { id: task.id, code });
        if (startTask(role, task, publish)) started = task.id;
      }
    } catch (error) {
      if (error.status === 403) {
        show('Debug station link is invalid.');
        return;
      }
      show('Waiting for the debug relay.');
    }
    setTimeout(poll, 2000);
  }

  void poll();
}
