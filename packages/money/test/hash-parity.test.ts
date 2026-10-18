// allocate() moved from node:crypto to @noble/hashes so the browser can run it. Splits already
// stored were computed with node:crypto; this proves the tie-break keys (and so every split) are
// unchanged: same bytes in, same digest out, for arbitrary seeds and ids including non-ASCII.
import { createHash } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runs } from './fc.js';

const nodeKey = (seed: string, id: string) => createHash('sha256').update(seed).update('\u0000').update(id).digest('hex');
const nobleKey = (seed: string, id: string) => bytesToHex(sha256(utf8ToBytes(`${seed}\u0000${id}`)));

describe('tie-break hash parity', () => {
  it('@noble/hashes sha256 equals node:crypto for any seed and member id', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' }), (seed, id) => {
      expect(nobleKey(seed, id)).toBe(nodeKey(seed, id));
    }), runs(5_000));
  });
});
