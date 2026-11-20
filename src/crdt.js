// A replicated growable array. Inserts name their predecessor and concurrent
// siblings sort by descending Lamport timestamp, then descending actor ID.
export class TextReplica {
  clock = 0;
  operations = new Map();
  children = new Map();
  deleted = new Set();

  constructor(actor = crypto.randomUUID()) {
    this.actor = actor;
  }

  apply(operations) {
    const accepted = [];
    for (const operation of operations) {
      const [actor, clock] = operation;
      const key = identifier(clock, actor);
      if (this.operations.has(key)) continue;
      this.operations.set(key, operation);
      accepted.push(operation);

      if (operation.length === 3) {
        for (const id of operation[2]) this.deleted.add(id);
        this.clock = Math.max(this.clock, clock);
        continue;
      }

      let [, , after, text] = operation;
      let timestamp = clock;
      for (const character of text) {
        const id = identifier(timestamp, actor);
        const siblings = this.children.get(after) ?? [];
        const index = siblings.findIndex(node =>
          node.clock < timestamp || (node.clock === timestamp && node.actor < actor));
        siblings.splice(index < 0 ? siblings.length : index, 0, {
          id, clock: timestamp, actor, character
        });
        this.children.set(after, siblings);
        after = id;
        timestamp++;
      }
      this.clock = Math.max(this.clock, timestamp - 1);
    }
    return accepted;
  }

  replace(displayed, nextText, startLimit = displayed.length) {
    const next = Array.from(nextText.toWellFormed());
    let start = 0;
    while (start < startLimit && start < displayed.length &&
           displayed[start].character === next[start]) start++;
    let end = displayed.length;
    let nextEnd = next.length;
    while (end > start && nextEnd > start &&
           displayed[end - 1].character === next[nextEnd - 1]) {
      end--;
      nextEnd--;
    }

    const operations = [];
    if (start < end) {
      operations.push([this.actor, ++this.clock, displayed.slice(start, end).map(node => node.id)]);
    }
    if (start < nextEnd) {
      operations.push([this.actor, ++this.clock, displayed[start - 1]?.id ?? '', next.slice(start, nextEnd).join('')]);
    }
    return this.apply(operations);
  }

  snapshot() {
    return [...this.operations.values()];
  }

  view() {
    const nodes = [];
    const offsets = new Map();
    const iterators = [this.children.get('')?.values()];
    let offset = 0;
    while (iterators.length) {
      const next = iterators.at(-1)?.next();
      if (!next || next.done) {
        iterators.pop();
        continue;
      }
      const node = next.value;
      offsets.set(node.id, offset);
      if (!this.deleted.has(node.id)) {
        nodes.push(node);
        offset += node.character.length;
      }
      const children = this.children.get(node.id);
      if (children) iterators.push(children.values());
    }
    return { nodes, offsets, text: nodes.map(node => node.character).join('') };
  }
}

function identifier(clock, actor) {
  return `${clock}:${actor}`;
}

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const nodeId = /^[1-9][0-9]{0,15}:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const validDocumentId = value => typeof value === 'string' && uuid.test(value);

export function validOperations(operations) {
  return Array.isArray(operations) && operations.every(operation => {
    if (!Array.isArray(operation)) return false;
    const [actor, clock, after, text] = operation;
    if (!validDocumentId(actor) || !Number.isSafeInteger(clock) || clock < 1) return false;
    if (operation.length === 3) {
      return Array.isArray(after) && after.length > 0 &&
        after.every(id => typeof id === 'string' && nodeId.test(id) && Number(id.split(':')[0]) < clock);
    }
    return operation.length === 4 && typeof text === 'string' && text.length > 0 &&
      text.isWellFormed() && !text.includes('\r') &&
      Number.isSafeInteger(clock + text.length) && typeof after === 'string' &&
      (!after || (nodeId.test(after) && Number(after.split(':')[0]) < clock));
  });
}

// The character just after the caret is a stable CRDT anchor, even if deleted.
export function remapOffset(offset, previous, next) {
  let position = 0;
  for (const node of previous) {
    position += node.character.length;
    if (position > offset) return next.offsets.get(node.id) ?? next.text.length;
  }
  return next.text.length;
}
