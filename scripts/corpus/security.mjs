// SPDX-License-Identifier: MIT
import { createHash, createCipheriv } from 'node:crypto';
import { hex, ref } from './pdf-bytes.mjs';

const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const hash = (algorithm, ...parts) => {
  const state = createHash(algorithm);
  for (const part of parts) state.update(part);
  return state.digest();
};
const md5 = (...parts) => hash('md5', ...parts);
const pad = ascii => Buffer.concat([Buffer.from(ascii, 'ascii'), padding], 32);

// RC4 only for writing deliberately obsolete synthetic PDF security profiles.
function rc4(data, key) {
  const permutation = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  const swap = (a, b) => { [permutation[a], permutation[b]] = [permutation[b], permutation[a]]; };
  for (let i = 0; i < 256; i++) {
    j = (j + permutation[i] + key[i % key.length]) & 255;
    swap(i, j);
  }
  j = 0;
  return Buffer.from(data).map((byte, k) => {
    const i = (k + 1) & 255;
    j = (j + permutation[i]) & 255;
    swap(i, j);
    return byte ^ permutation[(permutation[i] + permutation[j]) & 255];
  });
}

function rounds(data, key, count) {
  for (let round = 0; round < count; round++) data = rc4(data, key.map(v => v ^ round));
  return data;
}

export function secure(pdf, id, number) {
  const aes = number >= 5 && number !== 9;
  const required = number <= 8;
  const userPassword = required ? `reader-${id.toLowerCase()}-${'orbit'.repeat(number === 4 ? 7 : 1)}` : '';
  const ownerPassword = `owner-${id.toLowerCase()}-harbor`;
  const p = number === 9 ? -12 : [-4, -8, -20, -12][(number - 1) % 4];
  const encryptMetadata = !aes || number % 2 === 1;
  const n = aes ? 16 : 5;
  let ownerKey = md5(pad(ownerPassword));
  if (aes) for (let round = 0; round < 50; round++) ownerKey = md5(ownerKey);
  const o = rounds(pad(userPassword), ownerKey.subarray(0, n), aes ? 20 : 1);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(p);
  const fileId = Buffer.from(pdf.fileId, 'hex');
  let key = md5(pad(userPassword), o, permissions, fileId, encryptMetadata ? Buffer.alloc(0) : Buffer.alloc(4, 255));
  if (aes) for (let round = 0; round < 50; round++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  const u = aes ? Buffer.concat([rounds(md5(padding, fileId), key, 20), Buffer.alloc(16)]) : rc4(padding, key);
  const filters = aes ? `/Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /EncryptMetadata ${encryptMetadata}` : '';
  const enc = pdf.add(`<< /Filter /Standard /V ${aes ? 4 : 1} /R ${aes ? 4 : 2} /O ${hex(o)} /U ${hex(u)} /P ${p} ${filters} >>`);
  pdf.trailer = `/Encrypt ${ref(enc)}`;
  pdf.encrypt = (payload, object, gen) => {
    const suffix = Buffer.alloc(5);
    suffix.writeUIntLE(object, 0, 3);
    suffix.writeUInt16LE(gen, 3);
    const objectKey = md5(key, suffix, aes ? Buffer.from('sAlT') : Buffer.alloc(0)).subarray(0, Math.min(n + 5, 16));
    if (!aes) return rc4(payload, objectKey);
    // Deliberately reproducible for public test data only. Never use for real documents.
    const iv = hash('sha256', `phase0-fixture-iv:${id}:${object}:${gen}`).subarray(0, 16);
    const cipher = createCipheriv('aes-128-cbc', objectKey, iv);
    return Buffer.concat([iv, cipher.update(payload), cipher.final()]);
  };
  return { profile: aes ? 'AESV2-128-V4-R4' : 'RC4-40-V1-R2', required, userPassword, ownerPassword, permissions: p, encryptMetadata };
}
