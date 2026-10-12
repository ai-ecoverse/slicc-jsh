'use strict';
/**
 * SM3 (GB/T 32905-2016, as OpenSSL 3's default provider has it and Node 22
 * lists in crypto.getHashes()), on @noble/hashes' Merkle–Damgård base, the
 * way noble writes SHA-256.
 */
const { HashMD } = require('@noble/hashes/_md');
const { clean, createHasher, rotl } = require('@noble/hashes/utils');

const IV = Uint32Array.from([
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
]);
const W = new Uint32Array(68);
const P0 = (x) => x ^ rotl(x, 9) ^ rotl(x, 17);
const P1 = (x) => x ^ rotl(x, 15) ^ rotl(x, 23);

class SM3 extends HashMD {
  constructor() {
    super(64, 32, 8, false);
    [this.A, this.B, this.C, this.D, this.E, this.F, this.G, this.H] = IV;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let j = 0; j < 16; j++, offset += 4) W[j] = view.getUint32(offset, false);
    for (let j = 16; j < 68; j++) {
      W[j] = P1(W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15)) ^ rotl(W[j - 13], 7) ^ W[j - 6];
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let j = 0; j < 64; j++) {
      const T = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const A12 = rotl(A, 12);
      const SS1 = rotl((A12 + E + rotl(T, j % 32)) | 0, 7);
      const SS2 = SS1 ^ A12;
      const FF = j < 16 ? A ^ B ^ C : (A & B) | (A & C) | (B & C);
      const GG = j < 16 ? E ^ F ^ G : (E & F) | (~E & G);
      const TT1 = (FF + D + SS2 + (W[j] ^ W[j + 4])) | 0;
      const TT2 = (GG + H + SS1 + W[j]) | 0;
      D = C;
      C = rotl(B, 9);
      B = A;
      A = TT1;
      H = G;
      G = rotl(F, 19);
      F = E;
      E = P0(TT2);
    }
    this.set(A ^ this.A, B ^ this.B, C ^ this.C, D ^ this.D, E ^ this.E, F ^ this.F, G ^ this.G, H ^ this.H);
  }
  roundClean() {
    clean(W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
}

exports.SM3 = SM3;
exports.sm3 = createHasher(() => new SM3());
