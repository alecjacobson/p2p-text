import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validDocumentId } from './src/crdt.js';

export const branch = 'p2p-backup';
const ref = `refs/heads/${branch}`;

export class GitBackup {
  #queue = Promise.resolve();

  constructor(repo, push = false) {
    this.repo = repo;
    this.push = push;
  }

  async check() {
    await this.#git(['rev-parse', '--git-dir']);
    if (this.push) await this.#git(['remote', 'get-url', 'origin']);
  }

  write(doc, content) {
    if (!validDocumentId(doc) || typeof content !== 'string') {
      return Promise.reject(new Error('Invalid snapshot.'));
    }
    const next = this.#queue.then(() => this.#write(doc, content));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #write(doc, content) {
    const worktrees = await this.#git(['worktree', 'list', '--porcelain']);
    if (worktrees.split('\n').includes(`branch ${ref}`)) {
      throw new Error(`Check out another branch before backing up to ${branch}.`);
    }
    const path = `documents/${doc}.txt`;
    const local = await this.#git(['rev-parse', '--verify', '--quiet', ref], { allow: [1] });
    let parent = local;
    if (!parent && this.push) {
      const remote = await this.#git(['ls-remote', '--exit-code', 'origin', ref], { allow: [2] });
      if (remote) {
        await this.#git(['fetch', '--no-tags', 'origin', ref]);
        parent = await this.#git(['rev-parse', 'FETCH_HEAD']);
      }
    }

    const blob = await this.#git(['hash-object', '-w', '--stdin'], { input: content });
    const existing = parent
      ? await this.#git(['rev-parse', '--verify', '--quiet', `${parent}:${path}`], { allow: [1] })
      : '';
    let commit = parent;

    if (existing !== blob) {
      const directory = await mkdtemp(join(tmpdir(), 'short-overleaf-index-'));
      const index = join(directory, 'index');
      try {
        if (parent) await this.#git(['read-tree', parent], { index });
        await this.#git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { index });
        const tree = await this.#git(['write-tree'], { index });
        const args = ['commit-tree', tree, '-m', `Back up document ${doc.slice(0, 8)}`];
        if (parent) args.push('-p', parent);
        commit = await this.#git(args);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    if (commit !== local) await this.#git(['update-ref', ref, commit, local]);
    if (this.push) await this.#git(['push', 'origin', `${ref}:${ref}`]);
    return commit;
  }

  #git(args, { input, index, allow = [] } = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
      if (index) env.GIT_INDEX_FILE = index;
      const child = spawn('git', ['-C', this.repo, ...args], { env, timeout: 45000 });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => reject(new Error('Git could not be started.')));
      child.on('close', code => {
        if (code === 0) resolve(stdout.trim());
        else if (allow.includes(code)) resolve('');
        else if (args[0] === 'commit-tree') reject(new Error('Git commit failed. Check your Git name and email.'));
        else if (['push', 'fetch', 'ls-remote'].includes(args[0])) {
          reject(new Error(`Git ${args[0]} failed. Check origin credentials, connectivity, and branch history.`));
        } else {
          reject(new Error(`Git ${args[0]} failed. Check the checkout and permissions.`));
        }
      });
      child.stdin.end(input);
    });
  }
}
