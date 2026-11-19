// SPDX-License-Identifier: MIT
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const ref = (id, gen = 0) => `${id} ${gen} R`;
export const arr = items => `[${items.join(' ')}]`;
export const hex = data => `<${bytes(data).toString('hex')}>`;
export const str = value => `(${value.replace(/[\\()]/g, '\\$&')})`;
export const utf16 = value => hex(Buffer.concat([Buffer.from('feff', 'hex'), Buffer.from(value, 'utf16le').swap16()]));
export const stream = (data, dict = '', flate = false) => ({ data: bytes(data), dict, flate });

// A serializer for our fixture recipes, not a general PDF writer or reader.
export class Pdf {
  constructor(label, eol = '\n') {
    this.eol = eol;
    this.chunks = [];
    this.length = 0;
    this.next = 1;
    this.objects = new Map();
    this.pending = new Map();
    this.free = new Map();
    this.prev = null;
    this.trailer = '';
    this.fileId = digest(label).slice(0, 32);
    this.append(`%PDF-1.7${eol}%\xe7\xe8\xe9\xea${eol}% Synthetic ${label}${eol}`);
  }

  append(value) {
    const data = bytes(value);
    this.chunks.push(data);
    this.length += data.length;
  }
  reserve() { return this.next++; }
  add(body) { const id = this.reserve(); this.set(id, body); return id; }
  set(id, body, gen = 0) { this.pending.set(id, { body, gen }); }
  release(id, gen) { this.free.set(id, gen); }
  result() { return Buffer.concat(this.chunks); }

  object(id, body, gen = 0) {
    const offset = this.length;
    const e = this.eol;
    this.append(`${id} ${gen} obj${e}`);
    if (typeof body === 'string') {
      this.append(body);
    } else {
      let payload = body.flate ? deflateSync(body.data, { level: 9 }) : body.data;
      if (this.encrypt && !body.clear) payload = this.encrypt(payload, id, gen);
      this.append(`<< ${body.dict}${body.flate ? ' /Filter /FlateDecode' : ''} /Length ${payload.length} >>${e}stream${e === '\r' ? '\r\n' : e}`);
      this.append(payload);
      this.append(`${e}endstream`);
    }
    this.append(`${e}endobj${e}`);
    return [1, offset, gen];
  }

  flush() {
    const changed = new Map();
    for (const [id, { body, gen }] of this.pending) {
      this.free.delete(id);
      changed.set(id, this.object(id, body, gen));
    }
    this.pending.clear();
    if (this.prev === null) {
      for (let id = 1; id < this.next; id++) {
        if (!changed.has(id) && !this.objects.has(id) && !this.free.has(id)) this.release(id, 0);
      }
    }
    const reusable = [0, ...[...this.free.keys()].filter(id => this.free.get(id) !== 65535).sort((a, b) => a - b)];
    const freeEntry = (id, next, gen) => {
      const entry = [0, next, gen];
      if (!changed.has(id) && (this.objects.get(id) ?? []).join() !== entry.join()) changed.set(id, entry);
    };
    reusable.forEach((id, i) => freeEntry(id, reusable[i + 1] ?? 0, id === 0 ? 65535 : this.free.get(id)));
    for (const [id, gen] of this.free) if (gen === 65535) freeEntry(id, 0, gen);
    for (const [id, entry] of changed) this.objects.set(id, entry);
    return changed;
  }

  tail(extra = '') {
    return `/Size ${this.next} /Root 1 0 R /ID [<${this.fileId}> <${this.fileId}>] ${this.trailer}${this.prev === null ? '' : ` /Prev ${this.prev}`} ${extra}`;
  }
  finish(offset) {
    const e = this.eol;
    this.append(`startxref${e}${offset}${e}%%EOF${e}`);
    this.prev = offset;
  }
  table(splits, extra = '', changed = this.flush()) {
    const groups = splits ?? runs(changed.keys());
    const offset = this.length;
    const e = this.eol;
    this.append(`xref${e}`);
    for (const [first, count] of groups) {
      this.append(`${first} ${count}${e}`);
      for (let id = first; id < first + count; id++) {
        const [type, field, gen] = changed.get(id) ?? this.objects.get(id);
        if (type > 1) throw new Error('Compressed object in a classic table');
        this.append(`${String(field).padStart(10, '0')} ${String(gen).padStart(5, '0')} ${type ? 'n' : 'f'}${e.length === 1 ? ' ' : ''}${e}`);
      }
    }
    this.append(`trailer${e}<< ${this.tail(extra)} >>${e}`);
    this.finish(offset);
  }

  pack(ids, flate) {
    let header = '';
    let data = '';
    const container = this.reserve();
    ids.forEach((id, index) => {
      const member = this.pending.get(id);
      if (!member || typeof member.body !== 'string' || member.gen !== 0) throw new Error('Invalid object-stream member');
      header += `${id} ${bytes(data).length} `;
      data += `${member.body}\n`;
      this.pending.delete(id);
      this.free.delete(id);
      this.objects.set(id, [2, container, index]);
    });
    this.set(container, stream(header + data, `/Type /ObjStm /N ${ids.length} /First ${bytes(header).length}`, flate));
  }

  xstream({ widths = [1, 3, 2], index = 'implicit', flate = false, supplemental = [] } = {}) {
    const id = this.reserve();
    // Exclude the xref stream's own reserved slot from the free chain.
    this.objects.set(id, [1, 0, 0]);
    const changed = this.flush();
    const offset = this.length;
    const self = [1, offset, 0];
    this.objects.set(id, self);
    changed.set(id, self);
    let groups;
    if (index === 'hybrid') groups = runs(supplemental);
    else if (index === 'delta') groups = runs(changed.keys());
    else groups = [[0, this.next]];
    const encoded = [];
    for (const [first, count] of groups) {
      for (let key = first; key < first + count; key++) {
        const entry = this.objects.get(key);
        widths.forEach((width, i) => {
          if (!width) {
            if (entry[i] !== (i === 0 ? 1 : 0)) throw new Error('Non-default omitted xref field');
          } else {
            const field = Buffer.alloc(width);
            field.writeUIntBE(entry[i], 0, width);
            encoded.push(field);
          }
        });
      }
    }
    const dictionary = `/Type /XRef /W ${arr(widths)}${index === 'implicit' ? '' : ` /Index ${arr(groups.flat())}`} `;
    this.object(id, stream(Buffer.concat(encoded), dictionary + (index === 'hybrid' ? `/Size ${this.next}` : this.tail()), flate));
    if (index !== 'hybrid') this.finish(offset);
    else {
      // Carry already serialized live objects into the update table, not the hidden members.
      this.table(runs(changed.keys()), `/XRefStm ${offset}`, changed);
    }
  }
}

function runs(ids) {
  const groups = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const last = groups.at(-1);
    if (last && last[0] + last[1] === id) last[1]++;
    else groups.push([id, 1]);
  }
  return groups;
}
