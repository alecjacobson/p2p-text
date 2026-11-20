export const quietTime = 6000;

export class IdleBackup {
  stored;
  wanted;
  timer;
  pending = false;
  changedAt = 0;
  enabled = false;

  constructor(save, report, delay = quietTime) {
    this.save = save;
    this.report = report;
    this.delay = delay;
  }

  update(text) {
    if (text !== this.wanted) {
      this.wanted = text;
      this.changedAt = Date.now();
    }
    this.schedule();
  }

  enable(enabled) {
    this.enabled = enabled;
    if (enabled) this.changedAt = Date.now();
    this.schedule();
  }

  schedule(retry = 0) {
    clearTimeout(this.timer);
    if (!this.enabled || this.pending || this.wanted === undefined) return;
    if (this.wanted === this.stored) {
      this.report('Snapshot saved');
      return;
    }
    if (!retry) this.report('Waiting for a pause');
    this.timer = setTimeout(() => this.flush(), Math.max(retry, this.delay - (Date.now() - this.changedAt)));
  }

  async flush() {
    if (!this.enabled || this.pending || this.wanted === this.stored) return;
    this.pending = true;
    const snapshot = this.wanted;
    let retry = 0;
    this.report('Saving snapshot…');
    try {
      await this.save(snapshot);
      this.stored = snapshot;
    } catch (error) {
      this.report(error.message);
      retry = 15000;
    } finally {
      this.pending = false;
      this.schedule(retry);
    }
  }
}
