/**
 * Zstandard decoder: a port of Facebook's reference decoder (facebook/zstd
 * lib/decompress and the parts of lib/common it uses, v1.5.7; BSD, LICENSE
 * next to this file) to JavaScript. It follows the C code as Node 22.22.0
 * links it (deps/zstd: zstd 1.5.7, no legacy formats, no assembly), state
 * machine for state machine, so a stream decodes as in Node: the same output
 * for each call, the same input consumed, and the same error at the same
 * point. The build is a 64-bit one: the bit reader's container is 64 bits (two
 * 32-bit halves here), and Huffman decoding takes the fast C loop where Node
 * on a CPU with BMI2 (x86-64) or on arm64 does.
 *
 * Pointers are offsets into Uint8Arrays. Only what Node uses is ported:
 * ZSTD_decompressStream with ZSTD_DCtx_loadDictionary and
 * ZSTD_DCtx_setParameter; no legacy frames, no multiple DDicts.
 */

/* zstd_errors.h */
const E_GENERIC = 1;
const E_prefix_unknown = 10;
const E_frameParameter_unsupported = 14;
const E_frameParameter_windowTooLarge = 16;
const E_corruption_detected = 20;
const E_checksum_wrong = 22;
const E_literals_headerWrong = 24;
const E_dictionary_corrupted = 30;
const E_dictionary_wrong = 32;
const E_parameter_unsupported = 40;
const E_parameter_outOfBound = 42;
const E_tableLog_tooLarge = 44;
const E_maxSymbolValue_tooLarge = 46;
const E_maxSymbolValue_tooSmall = 48;
const E_stage_wrong = 60;
const E_memory_allocation = 64;
const E_dstSize_tooSmall = 70;
const E_srcSize_wrong = 72;
const E_dstBuffer_null = 74;
const E_noForwardProgress_destFull = 80;
const E_noForwardProgress_inputEmpty = 82;

/* An error is -code (C: (size_t)-code); a size is >= 0. */
const ERROR = (code) => -code;
const isError = (x) => x < 0;
export const getErrorCode = (x) => (x < 0 ? -x : 0);

const ERROR_NAMES = {
  0: 'no_error',
  1: 'GENERIC',
  10: 'prefix_unknown',
  12: 'version_unsupported',
  14: 'frameParameter_unsupported',
  16: 'frameParameter_windowTooLarge',
  20: 'corruption_detected',
  22: 'checksum_wrong',
  24: 'literals_headerWrong',
  30: 'dictionary_corrupted',
  32: 'dictionary_wrong',
  34: 'dictionaryCreation_failed',
  40: 'parameter_unsupported',
  41: 'parameter_combination_unsupported',
  42: 'parameter_outOfBound',
  44: 'tableLog_tooLarge',
  46: 'maxSymbolValue_tooLarge',
  48: 'maxSymbolValue_tooSmall',
  50: 'stabilityCondition_notRespected',
  60: 'stage_wrong',
  62: 'init_missing',
  64: 'memory_allocation',
  66: 'workSpace_tooSmall',
  70: 'dstSize_tooSmall',
  72: 'srcSize_wrong',
  74: 'dstBuffer_null',
  80: 'noForwardProgress_destFull',
  82: 'noForwardProgress_inputEmpty',
};

/** Node's ZstdStrerror: the code's name, for the codes Node lists. */
export function errorName(code) {
  return `ZSTD_error_${ERROR_NAMES[code] ?? 'GENERIC'}`;
}

/** ERR_getErrorString (error_private.c). */
export function errorString(code) {
  switch (code) {
    case 0: return 'No error detected';
    case 1: return 'Error (generic)';
    case 10: return 'Unknown frame descriptor';
    case 12: return 'Version not supported';
    case 14: return 'Unsupported frame parameter';
    case 16: return 'Frame requires too much memory for decoding';
    case 20: return 'Data corruption detected';
    case 22: return "Restored data doesn't match checksum";
    case 24: return "Header of Literals' block doesn't respect format specification";
    case 30: return 'Dictionary is corrupted';
    case 32: return 'Dictionary mismatch';
    case 34: return 'Cannot create Dictionary from provided samples';
    case 40: return 'Unsupported parameter';
    case 41: return 'Unsupported combination of parameters';
    case 42: return 'Parameter is out of bound';
    case 44: return 'tableLog requires too much memory : unsupported';
    case 46: return 'Unsupported max Symbol Value : too large';
    case 48: return 'Specified maxSymbolValue is too small';
    case 49: return 'This mode cannot generate an uncompressed block';
    case 50: return 'pledged buffer stability condition is not respected';
    case 60: return 'Operation not authorized at current processing stage';
    case 62: return 'Context should be init first';
    case 64: return 'Allocation error : not enough memory';
    case 66: return 'workSpace buffer is not large enough';
    case 70: return 'Destination buffer is too small';
    case 72: return 'Src size is incorrect';
    case 74: return 'Operation on NULL destination buffer';
    case 80: return 'Operation made no progress over multiple calls, due to output buffer being full';
    case 82: return 'Operation made no progress over multiple calls, due to input being empty';
    case 100: return 'Frame index is too large';
    case 102: return 'An I/O error occurred when reading/seeking';
    case 104: return 'Destination buffer is wrong';
    case 105: return 'Source buffer is wrong';
    case 106: return 'Block-level external sequence producer returned an error code';
    case 107: return 'External sequences are not valid';
    default: return 'Unspecified error code';
  }
}

/* zstd.h and zstd_internal.h */
const ZSTD_MAGICNUMBER = 0xfd2fb528;
const ZSTD_MAGIC_DICTIONARY = 0xec30a437;
const ZSTD_MAGIC_SKIPPABLE_START = 0x184d2a50;
const ZSTD_MAGIC_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_BLOCKSIZE_MAX = 1 << 17;
const ZSTD_BLOCKSIZE_MAX_MIN = 1 << 10;
const ZSTD_FRAMEHEADERSIZE_PREFIX = 5;
const ZSTD_FRAMEHEADERSIZE_MIN = 6;
const ZSTD_SKIPPABLEHEADERSIZE = 8;
const ZSTD_FRAMEIDSIZE = 4;
const ZSTD_blockHeaderSize = 3;
const ZSTD_WINDOWLOG_MAX = 31;
const ZSTD_WINDOWLOG_ABSOLUTEMIN = 10;
const ZSTD_WINDOWLOG_LIMIT_DEFAULT = 27;
const ZSTD_MAXWINDOWSIZE_DEFAULT = 2 ** ZSTD_WINDOWLOG_LIMIT_DEFAULT + 1;
const ZSTD_NO_FORWARD_PROGRESS_MAX = 16;
const ZSTD_WORKSPACETOOLARGE_FACTOR = 3;
const ZSTD_WORKSPACETOOLARGE_MAXDURATION = 128;
const ZSTD_REP_NUM = 3;
const MIN_SEQUENCES_SIZE = 1;
const MIN_CBLOCK_SIZE = 2;
const MIN_LITERALS_FOR_4_STREAMS = 6;
const LONGNBSEQ = 0x7f00;
const MaxML = 52;
const MaxLL = 35;
const MaxOff = 31;
const MLFSELog = 9;
const LLFSELog = 9;
const OffFSELog = 8;
const WILDCOPY_OVERLENGTH = 32;
const STREAM_ACCUMULATOR_MIN_64 = 57;
const ZSTD_LITBUFFEREXTRASIZE = 1 << 16;
const ZSTD_HUFFDTABLE_CAPACITY_LOG = 12;
/* ZSTD_CONTENTSIZE_UNKNOWN: frame content sizes are numbers, this is not one. */
const CONTENTSIZE_UNKNOWN = -1;

const ZSTD_did_fieldSize = [0, 1, 2, 4];
const ZSTD_fcs_fieldSize = [0, 2, 4, 8];
const repStartValue = [1, 4, 8];

const LL_bits = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const LL_defaultNorm = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1,
];
const ML_bits = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3,
  3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const ML_defaultNorm = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];
const OF_defaultNorm = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
const LL_DEFAULTNORMLOG = 6;
const ML_DEFAULTNORMLOG = 6;
const OF_DEFAULTNORMLOG = 5;
const LL_base = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 0x80, 0x100, 0x200,
  0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000, 0x10000,
];
const OF_base = [
  0, 1, 1, 5, 0xd, 0x1d, 0x3d, 0x7d, 0xfd, 0x1fd, 0x3fd, 0x7fd, 0xffd, 0x1ffd, 0x3ffd, 0x7ffd, 0xfffd, 0x1fffd,
  0x3fffd, 0x7fffd, 0xffffd, 0x1ffffd, 0x3ffffd, 0x7ffffd, 0xfffffd, 0x1fffffd, 0x3fffffd, 0x7fffffd, 0xffffffd,
  0x1ffffffd, 0x3ffffffd, 0x7ffffffd,
];
const OF_bits = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
];
const ML_base = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 0x83, 0x103, 0x203, 0x403, 0x803, 0x1003, 0x2003, 0x4003, 0x8003,
  0x10003,
];

/* mem.h */
const readLE16 = (b, p) => b[p] | (b[p + 1] << 8);
const readLE24 = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const readLE32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const highbit32 = (x) => 31 - Math.clz32(x);
const ctz32 = (x) => 31 - Math.clz32(x & -x);
const MASK = new Uint32Array(33);
for (let i = 1; i <= 32; i++) MASK[i] = i === 32 ? 0xffffffff : (2 ** i - 1) >>> 0;

/* xxhash.h: XXH64, for the content checksum. 64-bit words as two 32-bit
 * halves; mul64 and friends leave their result in R_HI and R_LO. */
let R_HI = 0;
let R_LO = 0;

function mul64(aHi, aLo, bHi, bLo) {
  const a0 = aLo & 0xffff;
  const a1 = aLo >>> 16;
  const a2 = aHi & 0xffff;
  const a3 = aHi >>> 16;
  const b0 = bLo & 0xffff;
  const b1 = bLo >>> 16;
  const b2 = bHi & 0xffff;
  const b3 = bHi >>> 16;
  let c0 = a0 * b0;
  let c1 = (c0 >>> 16) + a1 * b0;
  let c2 = c1 >>> 16;
  c1 = (c1 & 0xffff) + a0 * b1;
  c2 += c1 >>> 16;
  c2 += a2 * b0;
  let c3 = c2 >>> 16;
  c2 = (c2 & 0xffff) + a1 * b1;
  c3 += c2 >>> 16;
  c2 = (c2 & 0xffff) + a0 * b2;
  c3 += c2 >>> 16;
  c3 += a3 * b0 + a2 * b1 + a1 * b2 + a0 * b3;
  R_LO = ((c1 & 0xffff) << 16) | (c0 & 0xffff);
  R_HI = ((c3 & 0xffff) << 16) | (c2 & 0xffff);
  R_LO >>>= 0;
  R_HI >>>= 0;
}

function add64(aHi, aLo, bHi, bLo) {
  const lo = aLo + bLo;
  R_LO = lo >>> 0;
  R_HI = (aHi + bHi + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}

function rotl64(hi, lo, r) {
  if (r >= 32) {
    const t = hi;
    hi = lo;
    lo = t;
    r -= 32;
  }
  if (r === 0) {
    R_HI = hi >>> 0;
    R_LO = lo >>> 0;
    return;
  }
  R_HI = ((hi << r) | (lo >>> (32 - r))) >>> 0;
  R_LO = ((lo << r) | (hi >>> (32 - r))) >>> 0;
}

const P1_HI = 0x9e3779b1;
const P1_LO = 0x85ebca87;
const P2_HI = 0xc2b2ae3d;
const P2_LO = 0x27d4eb4f;
const P3_HI = 0x165667b1;
const P3_LO = 0x9e3779f9;
const P4_HI = 0x85ebca77;
const P4_LO = 0xc2b2ae63;
const P5_HI = 0x27d4eb2f;
const P5_LO = 0x165667c5;

/** XXH64_round: acc += input * P2; acc = rotl(acc, 31); acc *= P1. */
function xxhRound(accHi, accLo, inHi, inLo) {
  mul64(inHi, inLo, P2_HI, P2_LO);
  add64(accHi, accLo, R_HI, R_LO);
  rotl64(R_HI, R_LO, 31);
  mul64(R_HI, R_LO, P1_HI, P1_LO);
}

function xxhMergeRound(accHi, accLo, valHi, valLo) {
  xxhRound(0, 0, valHi, valLo);
  const hi = (accHi ^ R_HI) >>> 0;
  const lo = (accLo ^ R_LO) >>> 0;
  mul64(hi, lo, P1_HI, P1_LO);
  add64(R_HI, R_LO, P4_HI, P4_LO);
}

class XXH64State {
  reset() {
    this.total = 0;
    this.v = new Uint32Array(8);
    // v1 = seed + P1 + P2, v2 = seed + P2, v3 = seed, v4 = seed - P1 (seed 0).
    add64(P1_HI, P1_LO, P2_HI, P2_LO);
    this.v[0] = R_HI;
    this.v[1] = R_LO;
    this.v[2] = P2_HI;
    this.v[3] = P2_LO;
    this.v[4] = 0;
    this.v[5] = 0;
    // -P1 mod 2^64
    add64(~P1_HI >>> 0, ~P1_LO >>> 0, 0, 1);
    this.v[6] = R_HI;
    this.v[7] = R_LO;
    this.mem = new Uint8Array(32);
    this.memsize = 0;
  }

  stripe(b, p) {
    const v = this.v;
    for (let lane = 0; lane < 4; lane++) {
      const q = p + lane * 8;
      xxhRound(v[lane * 2], v[lane * 2 + 1], readLE32(b, q + 4), readLE32(b, q));
      v[lane * 2] = R_HI;
      v[lane * 2 + 1] = R_LO;
    }
  }

  update(b, p, len) {
    this.total += len;
    if (this.memsize + len < 32) {
      this.mem.set(b.subarray(p, p + len), this.memsize);
      this.memsize += len;
      return;
    }
    const end = p + len;
    if (this.memsize) {
      const fill = 32 - this.memsize;
      this.mem.set(b.subarray(p, p + fill), this.memsize);
      this.stripe(this.mem, 0);
      p += fill;
      this.memsize = 0;
    }
    while (p + 32 <= end) {
      this.stripe(b, p);
      p += 32;
    }
    if (p < end) {
      this.mem.set(b.subarray(p, end), 0);
      this.memsize = end - p;
    }
  }

  /** The low 32 bits of XXH64_digest. */
  digest32() {
    const v = this.v;
    let hi;
    let lo;
    if (this.total >= 32) {
      rotl64(v[0], v[1], 1);
      let h1 = R_HI;
      let l1 = R_LO;
      rotl64(v[2], v[3], 7);
      add64(h1, l1, R_HI, R_LO);
      h1 = R_HI;
      l1 = R_LO;
      rotl64(v[4], v[5], 12);
      add64(h1, l1, R_HI, R_LO);
      h1 = R_HI;
      l1 = R_LO;
      rotl64(v[6], v[7], 18);
      add64(h1, l1, R_HI, R_LO);
      hi = R_HI;
      lo = R_LO;
      for (let lane = 0; lane < 4; lane++) {
        xxhMergeRound(hi, lo, v[lane * 2], v[lane * 2 + 1]);
        hi = R_HI;
        lo = R_LO;
      }
    } else {
      hi = P5_HI;
      lo = P5_LO;
    }
    // h += total length (fits in 53 bits).
    add64(hi, lo, Math.floor(this.total / 2 ** 32) >>> 0, this.total >>> 0);
    hi = R_HI;
    lo = R_LO;
    // XXH64_finalize
    const m = this.mem;
    let p = 0;
    let len = this.memsize;
    while (len >= 8) {
      xxhRound(0, 0, readLE32(m, p + 4), readLE32(m, p));
      hi = (hi ^ R_HI) >>> 0;
      lo = (lo ^ R_LO) >>> 0;
      rotl64(hi, lo, 27);
      mul64(R_HI, R_LO, P1_HI, P1_LO);
      add64(R_HI, R_LO, P4_HI, P4_LO);
      hi = R_HI;
      lo = R_LO;
      p += 8;
      len -= 8;
    }
    if (len >= 4) {
      mul64(0, readLE32(m, p), P1_HI, P1_LO);
      hi = (hi ^ R_HI) >>> 0;
      lo = (lo ^ R_LO) >>> 0;
      rotl64(hi, lo, 23);
      mul64(R_HI, R_LO, P2_HI, P2_LO);
      add64(R_HI, R_LO, P3_HI, P3_LO);
      hi = R_HI;
      lo = R_LO;
      p += 4;
      len -= 4;
    }
    while (len > 0) {
      mul64(0, m[p], P5_HI, P5_LO);
      hi = (hi ^ R_HI) >>> 0;
      lo = (lo ^ R_LO) >>> 0;
      rotl64(hi, lo, 11);
      mul64(R_HI, R_LO, P1_HI, P1_LO);
      hi = R_HI;
      lo = R_LO;
      p++;
      len--;
    }
    // XXH64_avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32.
    lo = (lo ^ (hi >>> 1)) >>> 0;
    mul64(hi, lo, P2_HI, P2_LO);
    hi = R_HI;
    lo = R_LO;
    lo = (lo ^ ((lo >>> 29) | (hi << 3))) >>> 0;
    hi = (hi ^ (hi >>> 29)) >>> 0;
    mul64(hi, lo, P3_HI, P3_LO);
    return (R_LO ^ R_HI) >>> 0;
  }
}

/* bitstream.h: BIT_DStream_t with a 64-bit container (hi:lo). `ptr` is an
 * offset into `buf`; ZERO marks the C code's pointer to a zeroed container,
 * set once the stream has overflowed. */
const BIT_DStream_unfinished = 0;
const BIT_DStream_endOfBuffer = 1;
const BIT_DStream_completed = 2;
const BIT_DStream_overflow = 3;
const ZERO = -1;

class BitD {
  constructor() {
    this.buf = null;
    this.hi = 0;
    this.lo = 0;
    this.bitsConsumed = 0;
    this.ptr = 0;
    this.start = 0;
    this.limitPtr = 0;
  }
}

function loadLEST(d, p) {
  if (p === ZERO) {
    d.lo = 0;
    d.hi = 0;
    return;
  }
  const b = d.buf;
  d.lo = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  d.hi = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24)) >>> 0;
}

/** BIT_initDStream: the size, or an error. */
function bitInit(d, buf, src, srcSize) {
  d.buf = buf;
  if (srcSize < 1) {
    d.hi = d.lo = 0;
    d.bitsConsumed = 0;
    d.ptr = d.start = d.limitPtr = 0;
    d.buf = null;
    return ERROR(E_srcSize_wrong);
  }
  d.start = src;
  d.limitPtr = src + 8;
  if (srcSize >= 8) {
    d.ptr = src + srcSize - 8;
    loadLEST(d, d.ptr);
    const lastByte = buf[src + srcSize - 1];
    d.bitsConsumed = lastByte ? 8 - highbit32(lastByte) : 0;
    if (lastByte === 0) return ERROR(E_GENERIC);
  } else {
    d.ptr = src;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < srcSize; i++) {
      if (i < 4) lo |= buf[src + i] << (8 * i);
      else hi |= buf[src + i] << (8 * (i - 4));
    }
    d.lo = lo >>> 0;
    d.hi = hi >>> 0;
    const lastByte = buf[src + srcSize - 1];
    d.bitsConsumed = lastByte ? 8 - highbit32(lastByte) : 0;
    if (lastByte === 0) return ERROR(E_corruption_detected);
    d.bitsConsumed += (8 - srcSize) * 8;
  }
  return srcSize;
}

/** (container >> (s & 63)) & mask(n), n < 32. */
function middleBits(d, s, n) {
  s &= 63;
  let v;
  if (s === 0) v = d.lo;
  else if (s < 32) v = (d.lo >>> s) | (d.hi << (32 - s));
  else v = d.hi >>> (s - 32);
  return (v & MASK[n]) >>> 0;
}

/** BIT_lookBits */
function lookBits(d, n) {
  return middleBits(d, 64 - d.bitsConsumed - n, n);
}

/** BIT_lookBitsFast: (container << (consumed & 63)) >> ((64 - n) & 63), n >= 1. */
function lookBitsFast(d, n) {
  const s = d.bitsConsumed & 63;
  // The top n bits of (container << s).
  let hi;
  let lo;
  if (s === 0) {
    hi = d.hi;
    lo = d.lo;
  } else if (s < 32) {
    hi = ((d.hi << s) | (d.lo >>> (32 - s))) >>> 0;
    lo = (d.lo << s) >>> 0;
  } else {
    hi = (d.lo << (s - 32)) >>> 0;
    lo = 0;
  }
  const r = 64 - n;
  if (r >= 32) return hi >>> (r - 32);
  return ((lo >>> r) | (hi << (32 - r))) >>> 0;
}

function readBits(d, n) {
  const v = lookBits(d, n);
  d.bitsConsumed += n;
  return v;
}

function readBitsFast(d, n) {
  const v = lookBitsFast(d, n);
  d.bitsConsumed += n;
  return v;
}

function reloadInternal(d) {
  d.ptr -= d.bitsConsumed >> 3;
  d.bitsConsumed &= 7;
  loadLEST(d, d.ptr);
  return BIT_DStream_unfinished;
}

function reloadFast(d) {
  if (d.ptr < d.limitPtr) return BIT_DStream_overflow;
  return reloadInternal(d);
}

/** BIT_reloadDStream */
function reload(d) {
  if (d.bitsConsumed > 64) {
    d.ptr = ZERO;
    return BIT_DStream_overflow;
  }
  if (d.ptr >= d.limitPtr) return reloadInternal(d);
  if (d.ptr === d.start) {
    if (d.bitsConsumed < 64) return BIT_DStream_endOfBuffer;
    return BIT_DStream_completed;
  }
  let nbBytes = d.bitsConsumed >> 3;
  let result = BIT_DStream_unfinished;
  if (d.ptr - nbBytes < d.start) {
    nbBytes = d.ptr - d.start;
    result = BIT_DStream_endOfBuffer;
  }
  d.ptr -= nbBytes;
  d.bitsConsumed -= nbBytes * 8;
  loadLEST(d, d.ptr);
  return result;
}

/** BIT_endOfDStream */
const endOfDStream = (d) => d.ptr === d.start && d.bitsConsumed === 64;

/* entropy_common.c: FSE_readNCount. Returns the header size or an error;
 * sets NC_MAXSV and NC_TABLELOG. */
let NC_MAXSV = 0;
let NC_TABLELOG = 0;
const NC_PAD = new Uint8Array(8);

function readNCount(norm, maxSV, buf, ip0, hbSize) {
  if (hbSize < 8) {
    NC_PAD.fill(0);
    NC_PAD.set(buf.subarray(ip0, ip0 + hbSize));
    const countSize = readNCount(norm, maxSV, NC_PAD, 0, 8);
    if (isError(countSize)) return countSize;
    if (countSize > hbSize) return ERROR(E_corruption_detected);
    return countSize;
  }
  const istart = ip0;
  const iend = ip0 + hbSize;
  let ip = istart;
  let charnum = 0;
  const maxSV1 = maxSV + 1;
  let previous0 = 0;
  norm.fill(0, 0, maxSV + 1);
  let bitStream = readLE32(buf, ip);
  let nbBits = (bitStream & 0xf) + 5;
  if (nbBits > 15) return ERROR(E_tableLog_tooLarge);
  bitStream >>>= 4;
  let bitCount = 4;
  NC_TABLELOG = nbBits;
  let remaining = (1 << nbBits) + 1;
  let threshold = 1 << nbBits;
  nbBits++;
  for (;;) {
    if (previous0) {
      let repeats = ctz32(~bitStream | 0x80000000) >> 1;
      while (repeats >= 12) {
        charnum += 3 * 12;
        if (ip <= iend - 7) {
          ip += 3;
        } else {
          bitCount -= 8 * (iend - 7 - ip);
          bitCount &= 31;
          ip = iend - 4;
        }
        bitStream = readLE32(buf, ip) >>> bitCount;
        repeats = ctz32(~bitStream | 0x80000000) >> 1;
      }
      charnum += 3 * repeats;
      bitStream >>>= 2 * repeats;
      bitCount += 2 * repeats;
      charnum += bitStream & 3;
      bitCount += 2;
      if (charnum >= maxSV1) break;
      if (ip <= iend - 7 || ip + (bitCount >> 3) <= iend - 4) {
        ip += bitCount >> 3;
        bitCount &= 7;
      } else {
        bitCount -= 8 * (iend - 4 - ip);
        bitCount &= 31;
        ip = iend - 4;
      }
      bitStream = readLE32(buf, ip) >>> bitCount;
    }
    {
      const max = 2 * threshold - 1 - remaining;
      let count;
      if ((bitStream & (threshold - 1)) >>> 0 < max) {
        count = bitStream & (threshold - 1);
        bitCount += nbBits - 1;
      } else {
        count = bitStream & (2 * threshold - 1);
        if (count >= threshold) count -= max;
        bitCount += nbBits;
      }
      count--;
      if (count >= 0) remaining -= count;
      else remaining += count;
      norm[charnum++] = count;
      previous0 = !count;
      if (remaining < threshold) {
        if (remaining <= 1) break;
        nbBits = highbit32(remaining) + 1;
        threshold = 1 << (nbBits - 1);
      }
      if (charnum >= maxSV1) break;
      if (ip <= iend - 7 || ip + (bitCount >> 3) <= iend - 4) {
        ip += bitCount >> 3;
        bitCount &= 7;
      } else {
        bitCount -= 8 * (iend - 4 - ip);
        bitCount &= 31;
        ip = iend - 4;
      }
      bitStream = readLE32(buf, ip) >>> bitCount;
    }
  }
  if (remaining !== 1) return ERROR(E_corruption_detected);
  if (charnum > maxSV1) return ERROR(E_maxSymbolValue_tooSmall);
  if (bitCount > 32) return ERROR(E_corruption_detected);
  NC_MAXSV = charnum - 1;
  ip += (bitCount + 7) >> 3;
  return ip - istart;
}

/* fse.h / fse_decompress.c: the byte-symbol FSE decoder, for Huffman weights. */
const FSE_MAX_SYMBOL_VALUE = 255;
const FSE_MAX_TABLELOG = 12;
const FSE_TABLESTEP = (tableSize) => (tableSize >> 1) + (tableSize >> 3) + 3;
const FSE_DTABLE_SIZE_U32 = (log) => 1 + (1 << log);
const FSE_BUILD_DTABLE_WKSP_SIZE = (log, msv) => 2 * (msv + 1) + 2 ** log + 8;
const FSE_BUILD_DTABLE_WKSP_SIZE_U32 = (log, msv) => Math.floor((FSE_BUILD_DTABLE_WKSP_SIZE(log, msv) + 3) / 4);
const FSE_DECOMPRESS_WKSP_SIZE_U32 = (log, msv) =>
  FSE_DTABLE_SIZE_U32(log) + 1 + FSE_BUILD_DTABLE_WKSP_SIZE_U32(log, msv) + (FSE_MAX_SYMBOL_VALUE + 1) / 2 + 1;
const FSE_DECOMPRESS_WKSP_SIZE = (log, msv) => FSE_DECOMPRESS_WKSP_SIZE_U32(log, msv) * 4;
const HUF_TABLELOG_MAX = 12;
const HUF_SYMBOLVALUE_MAX = 255;
/* HUF_READ_STATS_WORKSPACE_SIZE: the size of the workspace HUF_readStats gets. */
const HUF_READ_STATS_WORKSPACE_SIZE = FSE_DECOMPRESS_WKSP_SIZE_U32(6, HUF_TABLELOG_MAX - 1) * 4;

const fseNorm = new Int16Array(FSE_MAX_SYMBOL_VALUE + 1);
const fseSymbol = new Uint8Array(1 << FSE_MAX_TABLELOG);
const fseNbBits = new Uint8Array(1 << FSE_MAX_TABLELOG);
const fseNewState = new Uint16Array(1 << FSE_MAX_TABLELOG);
const fseSymbolNext = new Uint16Array(FSE_MAX_SYMBOL_VALUE + 1);
const fseSpread = new Uint8Array((1 << FSE_MAX_TABLELOG) + 8 + 8 * (FSE_MAX_SYMBOL_VALUE + 1));
let fseTableLog = 0;
let fseFastMode = 0;

/** FSE_buildDTable_internal into the fse* tables. */
function fseBuildDTable(norm, maxSymbolValue, tableLog, wkspSize) {
  const maxSV1 = maxSymbolValue + 1;
  const tableSize = 1 << tableLog;
  let highThreshold = tableSize - 1;
  if (FSE_BUILD_DTABLE_WKSP_SIZE(tableLog, maxSymbolValue) > wkspSize) return ERROR(E_maxSymbolValue_tooLarge);
  if (maxSymbolValue > FSE_MAX_SYMBOL_VALUE) return ERROR(E_maxSymbolValue_tooLarge);
  if (tableLog > FSE_MAX_TABLELOG) return ERROR(E_tableLog_tooLarge);
  fseTableLog = tableLog;
  fseFastMode = 1;
  {
    const largeLimit = 1 << (tableLog - 1);
    for (let s = 0; s < maxSV1; s++) {
      if (norm[s] === -1) {
        fseSymbol[highThreshold--] = s;
        fseSymbolNext[s] = 1;
      } else {
        if (norm[s] >= largeLimit) fseFastMode = 0;
        fseSymbolNext[s] = norm[s];
      }
    }
  }
  if (highThreshold === tableSize - 1) {
    const tableMask = tableSize - 1;
    const step = FSE_TABLESTEP(tableSize);
    let pos = 0;
    for (let s = 0; s < maxSV1; s++) {
      const n = norm[s];
      fseSpread.fill(s, pos, pos + 8);
      for (let i = 8; i < n; i += 8) fseSpread.fill(s, pos + i, pos + i + 8);
      pos += n;
    }
    let position = 0;
    for (let s = 0; s < tableSize; s += 2) {
      for (let u = 0; u < 2; u++) fseSymbol[(position + u * step) & tableMask] = fseSpread[s + u];
      position = (position + 2 * step) & tableMask;
    }
  } else {
    const tableMask = tableSize - 1;
    const step = FSE_TABLESTEP(tableSize);
    let position = 0;
    for (let s = 0; s < maxSV1; s++) {
      for (let i = 0; i < norm[s]; i++) {
        fseSymbol[position] = s;
        position = (position + step) & tableMask;
        while (position > highThreshold) position = (position + step) & tableMask;
      }
    }
    if (position !== 0) return ERROR(E_GENERIC);
  }
  for (let u = 0; u < tableSize; u++) {
    const symbol = fseSymbol[u];
    const nextState = fseSymbolNext[symbol]++;
    const nb = tableLog - highbit32(nextState);
    fseNbBits[u] = nb;
    fseNewState[u] = ((nextState << nb) - tableSize) & 0xffff;
  }
  return 0;
}

/** FSE_decompress_usingDTable_generic */
function fseDecompressUsingDTable(dst, op0, maxDstSize, buf, cSrc, cSrcSize, fast) {
  let op = op0;
  const omax = op0 + maxDstSize;
  const olimit = omax - 3;
  const bitD = new BitD();
  const r = bitInit(bitD, buf, cSrc, cSrcSize);
  if (isError(r)) return r;
  let state1 = readBits(bitD, fseTableLog);
  reload(bitD);
  let state2 = readBits(bitD, fseTableLog);
  reload(bitD);
  if (reload(bitD) === BIT_DStream_overflow) return ERROR(E_corruption_detected);
  const get = (which) => {
    const st = which === 1 ? state1 : state2;
    const nb = fseNbBits[st];
    const sym = fseSymbol[st];
    const low = fast ? readBitsFast(bitD, nb) : readBits(bitD, nb);
    if (which === 1) state1 = fseNewState[st] + low;
    else state2 = fseNewState[st] + low;
    return sym;
  };
  // 4 symbols per loop; the 64-bit container needs no reload in between.
  for (; (reload(bitD) === BIT_DStream_unfinished) & (op < olimit); op += 4) {
    dst[op] = get(1);
    dst[op + 1] = get(2);
    dst[op + 2] = get(1);
    dst[op + 3] = get(2);
  }
  for (;;) {
    if (op > omax - 2) return ERROR(E_dstSize_tooSmall);
    dst[op++] = get(1);
    if (reload(bitD) === BIT_DStream_overflow) {
      dst[op++] = get(2);
      break;
    }
    if (op > omax - 2) return ERROR(E_dstSize_tooSmall);
    dst[op++] = get(2);
    if (reload(bitD) === BIT_DStream_overflow) {
      dst[op++] = get(1);
      break;
    }
  }
  return op - op0;
}

/** FSE_decompress_wksp_body */
function fseDecompressWksp(dst, op, dstCapacity, buf, ip, cSrcSize, maxLog, wkspSize) {
  const wkspHeader = 2 * (FSE_MAX_SYMBOL_VALUE + 1);
  if (wkspSize < wkspHeader) return ERROR(E_GENERIC);
  const NCountLength = readNCount(fseNorm, FSE_MAX_SYMBOL_VALUE, buf, ip, cSrcSize);
  if (isError(NCountLength)) return NCountLength;
  const tableLog = NC_TABLELOG;
  const maxSymbolValue = NC_MAXSV;
  if (tableLog > maxLog) return ERROR(E_tableLog_tooLarge);
  ip += NCountLength;
  cSrcSize -= NCountLength;
  if (FSE_DECOMPRESS_WKSP_SIZE(tableLog, maxSymbolValue) > wkspSize) return ERROR(E_tableLog_tooLarge);
  wkspSize -= wkspHeader + FSE_DTABLE_SIZE_U32(tableLog) * 4;
  const r = fseBuildDTable(fseNorm, maxSymbolValue, tableLog, wkspSize);
  if (isError(r)) return r;
  return fseDecompressUsingDTable(dst, op, dstCapacity, buf, ip, cSrcSize, fseFastMode);
}

/* HUF_readStats: weights into huffWeight, counts into rankStats. Returns the
 * size read or an error; sets HS_NBSYMBOLS and HS_TABLELOG. */
let HS_NBSYMBOLS = 0;
let HS_TABLELOG = 0;

function hufReadStats(huffWeight, hwSize, rankStats, buf, ip, srcSize, wkspSize) {
  if (!srcSize) return ERROR(E_srcSize_wrong);
  let iSize = buf[ip];
  let oSize;
  if (iSize >= 128) {
    oSize = iSize - 127;
    iSize = Math.floor((oSize + 1) / 2);
    if (iSize + 1 > srcSize) return ERROR(E_srcSize_wrong);
    if (oSize >= hwSize) return ERROR(E_corruption_detected);
    ip += 1;
    for (let n = 0; n < oSize; n += 2) {
      huffWeight[n] = buf[ip + n / 2] >> 4;
      huffWeight[n + 1] = buf[ip + n / 2] & 15;
    }
  } else {
    if (iSize + 1 > srcSize) return ERROR(E_srcSize_wrong);
    oSize = fseDecompressWksp(huffWeight, 0, hwSize - 1, buf, ip + 1, iSize, 6, wkspSize);
    if (isError(oSize)) return oSize;
  }
  rankStats.fill(0, 0, HUF_TABLELOG_MAX + 1);
  let weightTotal = 0;
  for (let n = 0; n < oSize; n++) {
    if (huffWeight[n] > HUF_TABLELOG_MAX) return ERROR(E_corruption_detected);
    rankStats[huffWeight[n]]++;
    weightTotal += (1 << huffWeight[n]) >> 1;
  }
  if (weightTotal === 0) return ERROR(E_corruption_detected);
  {
    const tableLog = highbit32(weightTotal) + 1;
    if (tableLog > HUF_TABLELOG_MAX) return ERROR(E_corruption_detected);
    HS_TABLELOG = tableLog;
    const total = 1 << tableLog;
    const rest = total - weightTotal;
    const verif = 1 << highbit32(rest);
    const lastWeight = highbit32(rest) + 1;
    if (verif !== rest) return ERROR(E_corruption_detected);
    huffWeight[oSize] = lastWeight;
    rankStats[lastWeight]++;
  }
  if (rankStats[1] < 2 || rankStats[1] & 1) return ERROR(E_corruption_detected);
  HS_NBSYMBOLS = oSize + 1;
  return iSize + 1;
}

/* huf_decompress.c. A HUF_DTable: the DTableDesc fields, and the table in one
 * buffer: X1 entries are u16 (byte << 8 | nbBits), X2 entries u32 (sequence |
 * nbBits << 16 | length << 24), as the C code lays them out. */
const HUF_DECODER_FAST_TABLELOG = 11;
const HUF_DECOMPRESS_WORKSPACE_SIZE = (2 << 10) + (1 << 9);

class HufDTable {
  constructor() {
    this.buf = new ArrayBuffer(4 << ZSTD_HUFFDTABLE_CAPACITY_LOG);
    this.u16 = new Uint16Array(this.buf);
    this.u32 = new Uint32Array(this.buf);
    this.init();
  }

  /** hufTable[0] = ZSTD_HUFFDTABLE_CAPACITY_LOG * 0x1000001 */
  init() {
    this.maxTableLog = ZSTD_HUFFDTABLE_CAPACITY_LOG;
    this.tableType = 0;
    this.tableLog = 0;
  }
}

function hufRescaleStats(huffWeight, rankVal, nbSymbols, tableLog, targetTableLog) {
  if (tableLog > targetTableLog) return tableLog;
  if (tableLog < targetTableLog) {
    const scale = targetTableLog - tableLog;
    for (let s = 0; s < nbSymbols; ++s) huffWeight[s] += huffWeight[s] === 0 ? 0 : scale;
    for (let s = targetTableLog; s > scale; --s) rankVal[s] = rankVal[s - scale];
    for (let s = scale; s > 0; --s) rankVal[s] = 0;
  }
  return targetTableLog;
}

const hufWeights = new Uint8Array(HUF_SYMBOLVALUE_MAX + 1);
const hufRankVal = new Uint32Array(HUF_TABLELOG_MAX + 1);
const hufRankStart = new Uint32Array(HUF_TABLELOG_MAX + 1);
const hufSymbols = new Uint8Array(HUF_SYMBOLVALUE_MAX + 1);
/* sizeof(HUF_ReadDTableX1_Workspace), sizeof(HUF_ReadDTableX2_Workspace) */
const X1_WKSP_SIZE = 4 * (HUF_TABLELOG_MAX + 1) * 2 + HUF_READ_STATS_WORKSPACE_SIZE + 2 * (HUF_SYMBOLVALUE_MAX + 1);
const X2_WKSP_SIZE =
  4 * HUF_TABLELOG_MAX * (HUF_TABLELOG_MAX + 1) +
  4 * (HUF_TABLELOG_MAX + 1) +
  4 * (HUF_TABLELOG_MAX + 3) +
  2 * (HUF_SYMBOLVALUE_MAX + 1) +
  HUF_READ_STATS_WORKSPACE_SIZE;

/** HUF_readDTableX1_wksp */
function hufReadDTableX1(DTable, buf, src, srcSize, wkspSize) {
  if (X1_WKSP_SIZE > wkspSize) return ERROR(E_tableLog_tooLarge);
  const iSize = hufReadStats(hufWeights, HUF_SYMBOLVALUE_MAX + 1, hufRankVal, buf, src, srcSize, HUF_READ_STATS_WORKSPACE_SIZE);
  if (isError(iSize)) return iSize;
  let tableLog = HS_TABLELOG;
  const nbSymbols = HS_NBSYMBOLS;
  {
    const maxTableLog = DTable.maxTableLog + 1;
    const targetTableLog = Math.min(maxTableLog, HUF_DECODER_FAST_TABLELOG);
    tableLog = hufRescaleStats(hufWeights, hufRankVal, nbSymbols, tableLog, targetTableLog);
    if (tableLog > DTable.maxTableLog + 1) return ERROR(E_tableLog_tooLarge);
    DTable.tableType = 0;
    DTable.tableLog = tableLog;
  }
  {
    let nextRankStart = 0;
    for (let n = 0; n < tableLog + 1; n++) {
      const curr = nextRankStart;
      nextRankStart += hufRankVal[n];
      hufRankStart[n] = curr;
    }
    for (let n = 0; n < nbSymbols; ++n) {
      const w = hufWeights[n];
      hufSymbols[hufRankStart[w]++] = n;
    }
  }
  {
    const dt = DTable.u16;
    let symbol = hufRankVal[0];
    let rankStart = 0;
    for (let w = 1; w < tableLog + 1; ++w) {
      const symbolCount = hufRankVal[w];
      const length = (1 << w) >> 1;
      let uStart = rankStart;
      const nbBits = tableLog + 1 - w;
      for (let s = 0; s < symbolCount; ++s) {
        const D = (hufSymbols[symbol + s] << 8) | nbBits;
        dt.fill(D, uStart, uStart + length);
        uStart += length;
      }
      symbol += symbolCount;
      rankStart += symbolCount * length;
    }
  }
  return iSize;
}

/** HUF_decodeStreamX1 */
function hufDecodeStreamX1(dst, p, bitD, pEnd, dt, dtLog) {
  const pStart = p;
  const decode = () => {
    const val = lookBitsFast(bitD, dtLog);
    const e = dt[val];
    bitD.bitsConsumed += e & 0xff;
    dst[p++] = e >> 8;
  };
  if (pEnd - p > 3) {
    while ((reload(bitD) === BIT_DStream_unfinished) & (p < pEnd - 3)) {
      decode();
      decode();
      decode();
      decode();
    }
  } else {
    reload(bitD);
  }
  while (p < pEnd) decode();
  return pEnd - pStart;
}

function hufDecompress1X1(dst, op, dstSize, buf, cSrc, cSrcSize, DTable) {
  const bitD = new BitD();
  const r = bitInit(bitD, buf, cSrc, cSrcSize);
  if (isError(r)) return r;
  hufDecodeStreamX1(dst, op, bitD, op + dstSize, DTable.u16, DTable.tableLog);
  if (!endOfDStream(bitD)) return ERROR(E_corruption_detected);
  return dstSize;
}

/** HUF_decompress4X1_usingDTable_internal_body (the default decoder) */
function hufDecompress4X1Body(dst, ostart, dstSize, buf, istart, cSrcSize, DTable) {
  if (cSrcSize < 10) return ERROR(E_corruption_detected);
  if (dstSize < 6) return ERROR(E_corruption_detected);
  const oend = ostart + dstSize;
  const olimit = oend - 3;
  const dt = DTable.u16;
  const dtLog = DTable.tableLog;
  const length1 = readLE16(buf, istart);
  const length2 = readLE16(buf, istart + 2);
  const length3 = readLE16(buf, istart + 4);
  const length4 = cSrcSize - (length1 + length2 + length3 + 6);
  const istart1 = istart + 6;
  const istart2 = istart1 + length1;
  const istart3 = istart2 + length2;
  const istart4 = istart3 + length3;
  const segmentSize = Math.floor((dstSize + 3) / 4);
  const opStart2 = ostart + segmentSize;
  const opStart3 = opStart2 + segmentSize;
  const opStart4 = opStart3 + segmentSize;
  const op = [ostart, opStart2, opStart3, opStart4];
  let endSignal = 1;
  if (length4 > cSrcSize || length4 < 0) return ERROR(E_corruption_detected);
  if (opStart4 > oend) return ERROR(E_corruption_detected);
  const bits = [new BitD(), new BitD(), new BitD(), new BitD()];
  const starts = [istart1, istart2, istart3, istart4];
  const lengths = [length1, length2, length3, length4];
  for (let i = 0; i < 4; i++) {
    const r = bitInit(bits[i], buf, starts[i], lengths[i]);
    if (isError(r)) return r;
  }
  const decode = (i) => {
    const d = bits[i];
    const val = lookBitsFast(d, dtLog);
    const e = dt[val];
    d.bitsConsumed += e & 0xff;
    dst[op[i]++] = e >> 8;
  };
  if (oend - op[3] >= 8) {
    for (; endSignal & (op[3] < olimit); ) {
      for (let k = 0; k < 4; k++) for (let i = 0; i < 4; i++) decode(i);
      endSignal &= reloadFast(bits[0]) === BIT_DStream_unfinished ? 1 : 0;
      endSignal &= reloadFast(bits[1]) === BIT_DStream_unfinished ? 1 : 0;
      endSignal &= reloadFast(bits[2]) === BIT_DStream_unfinished ? 1 : 0;
      endSignal &= reloadFast(bits[3]) === BIT_DStream_unfinished ? 1 : 0;
    }
  }
  if (op[0] > opStart2) return ERROR(E_corruption_detected);
  if (op[1] > opStart3) return ERROR(E_corruption_detected);
  if (op[2] > opStart4) return ERROR(E_corruption_detected);
  hufDecodeStreamX1(dst, op[0], bits[0], opStart2, dt, dtLog);
  hufDecodeStreamX1(dst, op[1], bits[1], opStart3, dt, dtLog);
  hufDecodeStreamX1(dst, op[2], bits[2], opStart4, dt, dtLog);
  hufDecodeStreamX1(dst, op[3], bits[3], oend, dt, dtLog);
  if (!(endOfDStream(bits[0]) && endOfDStream(bits[1]) && endOfDStream(bits[2]) && endOfDStream(bits[3]))) {
    return ERROR(E_corruption_detected);
  }
  return dstSize;
}

/* The fast loops' 64-bit containers: FB_HI[i], FB_LO[i]. */
const FB_HI = new Uint32Array(4);
const FB_LO = new Uint32Array(4);
const F_IP = new Float64Array(4);
const F_OP = new Float64Array(4);
const F_IEND = new Float64Array(4);
let F_ILOWEST = 0;
let F_OEND = 0;

function ctz64(hi, lo) {
  if (lo !== 0) return ctz32(lo);
  if (hi !== 0) return 32 + ctz32(hi);
  return 64;
}

function shl64(i, n) {
  if (n === 0) return;
  if (n >= 64) {
    FB_HI[i] = 0;
    FB_LO[i] = 0;
  } else if (n >= 32) {
    FB_HI[i] = FB_LO[i] << (n - 32);
    FB_LO[i] = 0;
  } else {
    FB_HI[i] = (FB_HI[i] << n) | (FB_LO[i] >>> (32 - n));
    FB_LO[i] = FB_LO[i] << n;
  }
}

function load64(i, buf, p) {
  FB_LO[i] = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
  FB_HI[i] = buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16) | (buf[p + 7] << 24);
}

/** HUF_DecompressFastArgs_init: 1, 0 (use the fallback), or an error. */
function hufFastArgsInit(dstSize, buf, istart, srcSize, dtLog, dst0) {
  const oend = dst0 + dstSize;
  if (dstSize === 0) return 0;
  if (srcSize < 10) return ERROR(E_corruption_detected);
  if (dtLog !== HUF_DECODER_FAST_TABLELOG) return 0;
  {
    const length1 = readLE16(buf, istart);
    const length2 = readLE16(buf, istart + 2);
    const length3 = readLE16(buf, istart + 4);
    const length4 = srcSize - (length1 + length2 + length3 + 6);
    F_IEND[0] = istart + 6;
    F_IEND[1] = F_IEND[0] + length1;
    F_IEND[2] = F_IEND[1] + length2;
    F_IEND[3] = F_IEND[2] + length3;
    // (size_t) length4: a "negative" one is huge.
    if (length1 < 8 || length2 < 8 || length3 < 8 || (length4 >= 0 && length4 < 8)) return 0;
    if (length4 > srcSize || length4 < 0) return ERROR(E_corruption_detected);
  }
  F_IP[0] = F_IEND[1] - 8;
  F_IP[1] = F_IEND[2] - 8;
  F_IP[2] = F_IEND[3] - 8;
  F_IP[3] = istart + srcSize - 8;
  const seg = Math.floor((dstSize + 3) / 4);
  F_OP[0] = dst0;
  F_OP[1] = F_OP[0] + seg;
  F_OP[2] = F_OP[1] + seg;
  F_OP[3] = F_OP[2] + seg;
  if (F_OP[3] >= oend) return 0;
  for (let i = 0; i < 4; i++) {
    // HUF_initFastDStream
    const ip = F_IP[i];
    const lastByte = buf[ip + 7];
    const bitsConsumed = lastByte ? 8 - highbit32(lastByte) : 0;
    load64(i, buf, ip);
    FB_LO[i] |= 1;
    shl64(i, bitsConsumed);
  }
  F_ILOWEST = istart;
  F_OEND = oend;
  return 1;
}

/** HUF_decompress4X1_usingDTable_internal_fast_c_loop */
function hufFastLoopX1(dst, buf, dt) {
  const oend = F_OEND;
  const ilowest = F_ILOWEST;
  for (;;) {
    const oiters = Math.floor((oend - F_OP[3]) / 5);
    const iiters = Math.floor((F_IP[0] - ilowest) / 7);
    const iters = Math.min(oiters, iiters);
    const olimit = F_OP[3] + iters * 5;
    if (F_OP[3] === olimit) break;
    for (let s = 1; s < 4; ++s) if (F_IP[s] < F_IP[s - 1]) return;
    do {
      for (let sym = 0; sym < 5; sym++) {
        for (let s = 0; s < 4; s++) {
          const entry = dt[FB_HI[s] >>> 21];
          shl64(s, entry & 0x3f);
          dst[F_OP[s] + sym] = (entry >> 8) & 0xff;
        }
      }
      for (let s = 0; s < 4; s++) {
        const ctz = ctz64(FB_HI[s], FB_LO[s]);
        const nbBits = ctz & 7;
        const nbBytes = ctz >> 3;
        F_OP[s] += 5;
        F_IP[s] -= nbBytes;
        load64(s, buf, F_IP[s]);
        FB_LO[s] |= 1;
        shl64(s, nbBits);
      }
    } while (F_OP[3] < olimit);
  }
}

/** HUF_initRemainingDStream */
function hufInitRemaining(bit, buf, stream, segmentEnd) {
  if (F_OP[stream] > segmentEnd) return ERROR(E_corruption_detected);
  if (F_IP[stream] < F_IEND[stream] - 8) return ERROR(E_corruption_detected);
  bit.buf = buf;
  loadLEST(bit, F_IP[stream]);
  bit.bitsConsumed = ctz64(FB_HI[stream], FB_LO[stream]);
  bit.start = F_ILOWEST;
  bit.limitPtr = bit.start + 8;
  bit.ptr = F_IP[stream];
  return 0;
}

/** HUF_decompress4X1_usingDTable_internal_fast: dstSize, 0 (fallback) or an error. */
function hufDecompress4X1Fast(dst, op0, dstSize, buf, cSrc, cSrcSize, DTable) {
  const oend = op0 + dstSize;
  const ret = hufFastArgsInit(dstSize, buf, cSrc, cSrcSize, DTable.tableLog, op0);
  if (isError(ret)) return ret;
  if (ret === 0) return 0;
  hufFastLoopX1(dst, buf, DTable.u16);
  const segmentSize = Math.floor((dstSize + 3) / 4);
  let segmentEnd = op0;
  for (let i = 0; i < 4; ++i) {
    const bit = new BitD();
    if (segmentSize <= oend - segmentEnd) segmentEnd += segmentSize;
    else segmentEnd = oend;
    const r = hufInitRemaining(bit, buf, i, segmentEnd);
    if (isError(r)) return r;
    F_OP[i] += hufDecodeStreamX1(dst, F_OP[i], bit, segmentEnd, DTable.u16, HUF_DECODER_FAST_TABLELOG);
    if (F_OP[i] !== segmentEnd) return ERROR(E_corruption_detected);
  }
  return dstSize;
}

/** HUF_decompress4X1_usingDTable_internal, with Node's fast path. */
function hufDecompress4X1(dst, op, dstSize, buf, cSrc, cSrcSize, DTable) {
  const ret = hufDecompress4X1Fast(dst, op, dstSize, buf, cSrc, cSrcSize, DTable);
  if (ret !== 0) return ret;
  return hufDecompress4X1Body(dst, op, dstSize, buf, cSrc, cSrcSize, DTable);
}

/* X2: double-symbol decoding. */
const buildDEltX2U32 = (symbol, nbBits, baseSeq, level) =>
  ((level === 1 ? symbol : baseSeq + (symbol << 8)) + (nbBits << 16) + (level << 24)) >>> 0;

function hufFillDTableX2ForWeight(dt, rank, sortedSymbols, begin, end, nbBits, tableLog, baseSeq, level) {
  const length = 1 << ((tableLog - nbBits) & 0x1f);
  for (let ptr = begin; ptr !== end; ++ptr) {
    const DElt = buildDEltX2U32(sortedSymbols[ptr], nbBits, baseSeq, level);
    dt.fill(DElt, rank, rank + length);
    rank += length;
  }
}

function hufFillDTableX2Level2(dt, base, targetLog, consumedBits, rankVal, minWeight, maxWeight1, sortedSymbols, rankStart, nbBitsBaseline, baseSeq) {
  if (minWeight > 1) {
    const length = 1 << ((targetLog - consumedBits) & 0x1f);
    const DElt = buildDEltX2U32(baseSeq, consumedBits, 0, 1);
    const skipSize = rankVal[minWeight];
    switch (length) {
      case 2:
        dt.fill(DElt, base, base + 2);
        break;
      case 4:
        dt.fill(DElt, base, base + 4);
        break;
      default:
        for (let i = 0; i < skipSize; i += 8) dt.fill(DElt, base + i, base + i + 8);
    }
  }
  for (let w = minWeight; w < maxWeight1; ++w) {
    const begin = rankStart[w];
    const end = rankStart[w + 1];
    const nbBits = nbBitsBaseline - w;
    const totalBits = nbBits + consumedBits;
    hufFillDTableX2ForWeight(dt, base + rankVal[w], sortedSymbols, begin, end, totalBits, targetLog, baseSeq, 2);
  }
}

/* HUF_ReadDTableX2_Workspace */
const x2RankVal = Array.from({ length: HUF_TABLELOG_MAX }, () => new Uint32Array(HUF_TABLELOG_MAX + 1));
const x2RankStats = new Uint32Array(HUF_TABLELOG_MAX + 1);
const x2RankStart0 = new Uint32Array(HUF_TABLELOG_MAX + 3);
const x2Sorted = new Uint8Array(HUF_SYMBOLVALUE_MAX + 1);
const x2Weights = new Uint8Array(HUF_SYMBOLVALUE_MAX + 1);

/** HUF_readDTableX2_wksp */
function hufReadDTableX2(DTable, buf, src, srcSize, wkspSize) {
  let maxTableLog = DTable.maxTableLog;
  if (X2_WKSP_SIZE > wkspSize) return ERROR(E_GENERIC);
  // rankStart = rankStart0 + 1
  const rankStart = x2RankStart0.subarray(1);
  x2RankStats.fill(0);
  x2RankStart0.fill(0);
  if (maxTableLog > HUF_TABLELOG_MAX) return ERROR(E_tableLog_tooLarge);
  const iSize = hufReadStats(x2Weights, HUF_SYMBOLVALUE_MAX + 1, x2RankStats, buf, src, srcSize, HUF_READ_STATS_WORKSPACE_SIZE);
  if (isError(iSize)) return iSize;
  const tableLog = HS_TABLELOG;
  const nbSymbols = HS_NBSYMBOLS;
  if (tableLog > maxTableLog) return ERROR(E_tableLog_tooLarge);
  if (tableLog <= HUF_DECODER_FAST_TABLELOG && maxTableLog > HUF_DECODER_FAST_TABLELOG) {
    maxTableLog = HUF_DECODER_FAST_TABLELOG;
  }
  let maxW = tableLog;
  while (x2RankStats[maxW] === 0) maxW--;
  {
    let nextRankStart = 0;
    for (let w = 1; w < maxW + 1; w++) {
      const curr = nextRankStart;
      nextRankStart += x2RankStats[w];
      rankStart[w] = curr;
    }
    rankStart[0] = nextRankStart;
    rankStart[maxW + 1] = nextRankStart;
  }
  for (let s = 0; s < nbSymbols; s++) {
    const w = x2Weights[s];
    const r = rankStart[w]++;
    x2Sorted[r] = s;
  }
  rankStart[0] = 0;
  {
    const rankVal0 = x2RankVal[0];
    const rescale = maxTableLog - tableLog - 1;
    let nextRankVal = 0;
    for (let w = 1; w < maxW + 1; w++) {
      const curr = nextRankVal;
      nextRankVal += x2RankStats[w] * 2 ** (w + rescale);
      rankVal0[w] = curr;
    }
    const minBits = tableLog + 1 - maxW;
    for (let consumed = minBits; consumed < maxTableLog - minBits + 1; consumed++) {
      const rankValPtr = x2RankVal[consumed];
      for (let w = 1; w < maxW + 1; w++) rankValPtr[w] = rankVal0[w] >>> consumed;
    }
  }
  // HUF_fillDTableX2
  {
    const dt = DTable.u32;
    const targetLog = maxTableLog;
    const nbBitsBaseline = tableLog + 1;
    const rankVal = x2RankVal[0];
    const scaleLog = nbBitsBaseline - targetLog;
    const minBits = nbBitsBaseline - maxW;
    const wEnd = maxW + 1;
    // HUF_fillDTableX2 gets rankStart0 (not rankStart).
    const rs = x2RankStart0;
    for (let w = 1; w < wEnd; ++w) {
      const begin = rs[w];
      const end = rs[w + 1];
      const nbBits = nbBitsBaseline - w;
      if (targetLog - nbBits >= minBits) {
        let start = rankVal[w];
        const length = 1 << ((targetLog - nbBits) & 0x1f);
        let minWeight = nbBits + scaleLog;
        if (minWeight < 1) minWeight = 1;
        for (let s = begin; s !== end; ++s) {
          hufFillDTableX2Level2(dt, start, targetLog, nbBits, x2RankVal[nbBits], minWeight, wEnd, x2Sorted, rs, nbBitsBaseline, x2Sorted[s]);
          start += length;
        }
      } else {
        hufFillDTableX2ForWeight(dt, rankVal[w], x2Sorted, begin, end, nbBits, targetLog, 0, 1);
      }
    }
  }
  DTable.tableLog = maxTableLog;
  DTable.tableType = 1;
  return iSize;
}

/** HUF_decodeSymbolX2: writes 2 bytes, returns the length. */
function hufDecodeSymbolX2(dst, op, d, dt, dtLog) {
  const val = lookBitsFast(d, dtLog);
  const e = dt[val];
  dst[op] = e & 0xff;
  dst[op + 1] = (e >>> 8) & 0xff;
  d.bitsConsumed += (e >>> 16) & 0xff;
  return e >>> 24;
}

function hufDecodeLastSymbolX2(dst, op, d, dt, dtLog) {
  const val = lookBitsFast(d, dtLog);
  const e = dt[val];
  dst[op] = e & 0xff;
  if (e >>> 24 === 1) {
    d.bitsConsumed += (e >>> 16) & 0xff;
  } else if (d.bitsConsumed < 64) {
    d.bitsConsumed += (e >>> 16) & 0xff;
    if (d.bitsConsumed > 64) d.bitsConsumed = 64;
  }
  return 1;
}

/** HUF_decodeStreamX2 */
function hufDecodeStreamX2(dst, p, bitD, pEnd, dt, dtLog) {
  const pStart = p;
  if (pEnd - p >= 8) {
    if (dtLog <= 11) {
      while ((reload(bitD) === BIT_DStream_unfinished) & (p < pEnd - 9)) {
        for (let k = 0; k < 5; k++) p += hufDecodeSymbolX2(dst, p, bitD, dt, dtLog);
      }
    } else {
      while ((reload(bitD) === BIT_DStream_unfinished) & (p < pEnd - 7)) {
        for (let k = 0; k < 4; k++) p += hufDecodeSymbolX2(dst, p, bitD, dt, dtLog);
      }
    }
  } else {
    reload(bitD);
  }
  if (pEnd - p >= 2) {
    while ((reload(bitD) === BIT_DStream_unfinished) & (p <= pEnd - 2)) p += hufDecodeSymbolX2(dst, p, bitD, dt, dtLog);
    while (p <= pEnd - 2) p += hufDecodeSymbolX2(dst, p, bitD, dt, dtLog);
  }
  if (p < pEnd) p += hufDecodeLastSymbolX2(dst, p, bitD, dt, dtLog);
  return p - pStart;
}

function hufDecompress1X2(dst, op, dstSize, buf, cSrc, cSrcSize, DTable) {
  const bitD = new BitD();
  const r = bitInit(bitD, buf, cSrc, cSrcSize);
  if (isError(r)) return r;
  hufDecodeStreamX2(dst, op, bitD, op + dstSize, DTable.u32, DTable.tableLog);
  if (!endOfDStream(bitD)) return ERROR(E_corruption_detected);
  return dstSize;
}

/** HUF_decompress4X2_usingDTable_internal_body */
function hufDecompress4X2Body(dst, ostart, dstSize, buf, istart, cSrcSize, DTable) {
  if (cSrcSize < 10) return ERROR(E_corruption_detected);
  if (dstSize < 6) return ERROR(E_corruption_detected);
  const oend = ostart + dstSize;
  const olimit = oend - 7;
  const dt = DTable.u32;
  const dtLog = DTable.tableLog;
  const length1 = readLE16(buf, istart);
  const length2 = readLE16(buf, istart + 2);
  const length3 = readLE16(buf, istart + 4);
  const length4 = cSrcSize - (length1 + length2 + length3 + 6);
  const istart1 = istart + 6;
  const istart2 = istart1 + length1;
  const istart3 = istart2 + length2;
  const istart4 = istart3 + length3;
  const segmentSize = Math.floor((dstSize + 3) / 4);
  const opStart2 = ostart + segmentSize;
  const opStart3 = opStart2 + segmentSize;
  const opStart4 = opStart3 + segmentSize;
  const op = [ostart, opStart2, opStart3, opStart4];
  let endSignal = 1;
  if (length4 > cSrcSize || length4 < 0) return ERROR(E_corruption_detected);
  if (opStart4 > oend) return ERROR(E_corruption_detected);
  const bits = [new BitD(), new BitD(), new BitD(), new BitD()];
  const starts = [istart1, istart2, istart3, istart4];
  const lengths = [length1, length2, length3, length4];
  for (let i = 0; i < 4; i++) {
    const r = bitInit(bits[i], buf, starts[i], lengths[i]);
    if (isError(r)) return r;
  }
  if (oend - op[3] >= 8) {
    for (; endSignal & (op[3] < olimit); ) {
      for (let k = 0; k < 4; k++) {
        for (let i = 0; i < 4; i++) op[i] += hufDecodeSymbolX2(dst, op[i], bits[i], dt, dtLog);
      }
      endSignal =
        (reloadFast(bits[0]) === BIT_DStream_unfinished) &
        (reloadFast(bits[1]) === BIT_DStream_unfinished) &
        (reloadFast(bits[2]) === BIT_DStream_unfinished) &
        (reloadFast(bits[3]) === BIT_DStream_unfinished);
    }
  }
  if (op[0] > opStart2) return ERROR(E_corruption_detected);
  if (op[1] > opStart3) return ERROR(E_corruption_detected);
  if (op[2] > opStart4) return ERROR(E_corruption_detected);
  hufDecodeStreamX2(dst, op[0], bits[0], opStart2, dt, dtLog);
  hufDecodeStreamX2(dst, op[1], bits[1], opStart3, dt, dtLog);
  hufDecodeStreamX2(dst, op[2], bits[2], opStart4, dt, dtLog);
  hufDecodeStreamX2(dst, op[3], bits[3], oend, dt, dtLog);
  if (!(endOfDStream(bits[0]) && endOfDStream(bits[1]) && endOfDStream(bits[2]) && endOfDStream(bits[3]))) {
    return ERROR(E_corruption_detected);
  }
  return dstSize;
}

/** HUF_decompress4X2_usingDTable_internal_fast_c_loop */
function hufFastLoopX2(dst, buf, dt) {
  const ilowest = F_ILOWEST;
  const oend = [F_OP[1], F_OP[2], F_OP[3], F_OEND];
  const decode = (s) => {
    const entry = dt[FB_HI[s] >>> 21];
    dst[F_OP[s]] = entry & 0xff;
    dst[F_OP[s] + 1] = (entry >>> 8) & 0xff;
    shl64(s, (entry >>> 16) & 0x3f);
    F_OP[s] += entry >>> 24;
  };
  for (;;) {
    let iters = Math.floor((F_IP[0] - ilowest) / 7);
    for (let s = 0; s < 4; ++s) iters = Math.min(iters, Math.floor((oend[s] - F_OP[s]) / 10));
    const olimit = F_OP[3] + iters * 5;
    if (F_OP[3] === olimit) break;
    for (let s = 1; s < 4; ++s) if (F_IP[s] < F_IP[s - 1]) return;
    do {
      for (let k = 0; k < 5; k++) for (let s = 0; s < 3; s++) decode(s);
      decode(3);
      for (let s = 0; s < 4; s++) {
        decode(3);
        const ctz = ctz64(FB_HI[s], FB_LO[s]);
        const nbBits = ctz & 7;
        const nbBytes = ctz >> 3;
        F_IP[s] -= nbBytes;
        load64(s, buf, F_IP[s]);
        FB_LO[s] |= 1;
        shl64(s, nbBits);
      }
    } while (F_OP[3] < olimit);
  }
}

function hufDecompress4X2Fast(dst, op0, dstSize, buf, cSrc, cSrcSize, DTable) {
  const oend = op0 + dstSize;
  const ret = hufFastArgsInit(dstSize, buf, cSrc, cSrcSize, DTable.tableLog, op0);
  if (isError(ret)) return ret;
  if (ret === 0) return 0;
  hufFastLoopX2(dst, buf, DTable.u32);
  const segmentSize = Math.floor((dstSize + 3) / 4);
  let segmentEnd = op0;
  for (let i = 0; i < 4; ++i) {
    const bit = new BitD();
    if (segmentSize <= oend - segmentEnd) segmentEnd += segmentSize;
    else segmentEnd = oend;
    const r = hufInitRemaining(bit, buf, i, segmentEnd);
    if (isError(r)) return r;
    F_OP[i] += hufDecodeStreamX2(dst, F_OP[i], bit, segmentEnd, DTable.u32, HUF_DECODER_FAST_TABLELOG);
    if (F_OP[i] !== segmentEnd) return ERROR(E_corruption_detected);
  }
  return dstSize;
}

function hufDecompress4X2(dst, op, dstSize, buf, cSrc, cSrcSize, DTable) {
  const ret = hufDecompress4X2Fast(dst, op, dstSize, buf, cSrc, cSrcSize, DTable);
  if (ret !== 0) return ret;
  return hufDecompress4X2Body(dst, op, dstSize, buf, cSrc, cSrcSize, DTable);
}

/* Universal selectors */
const algoTime = [
  [[0, 0], [1, 1]],
  [[0, 0], [1, 1]],
  [[150, 216], [381, 119]],
  [[170, 205], [514, 112]],
  [[177, 199], [539, 110]],
  [[197, 194], [644, 107]],
  [[221, 192], [735, 107]],
  [[256, 189], [881, 106]],
  [[359, 188], [1167, 109]],
  [[582, 187], [1570, 114]],
  [[688, 187], [1712, 122]],
  [[825, 186], [1965, 136]],
  [[976, 185], [2131, 150]],
  [[1180, 186], [2070, 175]],
  [[1377, 185], [1731, 202]],
  [[1412, 185], [1695, 202]],
];

function hufSelectDecoder(dstSize, cSrcSize) {
  const Q = cSrcSize >= dstSize ? 15 : Math.floor((cSrcSize * 16) / dstSize);
  const D256 = Math.floor(dstSize / 256);
  const DTime0 = algoTime[Q][0][0] + algoTime[Q][0][1] * D256;
  let DTime1 = algoTime[Q][1][0] + algoTime[Q][1][1] * D256;
  DTime1 += DTime1 >>> 5;
  return DTime1 < DTime0 ? 1 : 0;
}

function hufDecompress1XUsingDTable(dst, op, maxDstSize, buf, cSrc, cSrcSize, DTable) {
  return DTable.tableType
    ? hufDecompress1X2(dst, op, maxDstSize, buf, cSrc, cSrcSize, DTable)
    : hufDecompress1X1(dst, op, maxDstSize, buf, cSrc, cSrcSize, DTable);
}

function hufDecompress4XUsingDTable(dst, op, maxDstSize, buf, cSrc, cSrcSize, DTable) {
  return DTable.tableType
    ? hufDecompress4X2(dst, op, maxDstSize, buf, cSrc, cSrcSize, DTable)
    : hufDecompress4X1(dst, op, maxDstSize, buf, cSrc, cSrcSize, DTable);
}

/** HUF_decompress1X1_DCtx_wksp */
function hufDecompress1X1DCtx(DTable, dst, op, dstSize, buf, cSrc, cSrcSize) {
  const hSize = hufReadDTableX1(DTable, buf, cSrc, cSrcSize, HUF_DECOMPRESS_WORKSPACE_SIZE);
  if (isError(hSize)) return hSize;
  if (hSize >= cSrcSize) return ERROR(E_srcSize_wrong);
  return hufDecompress1X1(dst, op, dstSize, buf, cSrc + hSize, cSrcSize - hSize, DTable);
}

/** HUF_decompress4X_hufOnly_wksp */
function hufDecompress4XHufOnly(DTable, dst, op, dstSize, buf, cSrc, cSrcSize) {
  if (dstSize === 0) return ERROR(E_dstSize_tooSmall);
  if (cSrcSize === 0) return ERROR(E_corruption_detected);
  const algoNb = hufSelectDecoder(dstSize, cSrcSize);
  const hSize = algoNb
    ? hufReadDTableX2(DTable, buf, cSrc, cSrcSize, HUF_DECOMPRESS_WORKSPACE_SIZE)
    : hufReadDTableX1(DTable, buf, cSrc, cSrcSize, HUF_DECOMPRESS_WORKSPACE_SIZE);
  if (isError(hSize)) return hSize;
  if (hSize >= cSrcSize) return ERROR(E_srcSize_wrong);
  return algoNb
    ? hufDecompress4X2(dst, op, dstSize, buf, cSrc + hSize, cSrcSize - hSize, DTable)
    : hufDecompress4X1(dst, op, dstSize, buf, cSrc + hSize, cSrcSize - hSize, DTable);
}

/* zstd_decompress_block.c */

/** A ZSTD_seqSymbol table: header fields, then the cells as columns. */
class SeqTable {
  constructor(log) {
    const n = 1 << log;
    this.fastMode = 0;
    this.tableLog = 0;
    this.nextState = new Uint16Array(n);
    this.nbAdd = new Uint8Array(n);
    this.nbBits = new Uint8Array(n);
    this.base = new Uint32Array(n);
  }
}

const seqSymbolNext = new Uint16Array(MaxML + 1);
const seqSpread = new Uint8Array((1 << 9) + 8 + 8 * (MaxML + 1));

/** ZSTD_buildFSETable */
function buildFSETable(dt, norm, maxSymbolValue, baseValue, nbAdditionalBits, tableLog) {
  const maxSV1 = maxSymbolValue + 1;
  const tableSize = 1 << tableLog;
  let highThreshold = tableSize - 1;
  dt.tableLog = tableLog;
  dt.fastMode = 1;
  {
    const largeLimit = 1 << (tableLog - 1);
    for (let s = 0; s < maxSV1; s++) {
      if (norm[s] === -1) {
        dt.base[highThreshold--] = s;
        seqSymbolNext[s] = 1;
      } else {
        if (norm[s] >= largeLimit) dt.fastMode = 0;
        seqSymbolNext[s] = norm[s];
      }
    }
  }
  if (highThreshold === tableSize - 1) {
    const tableMask = tableSize - 1;
    const step = FSE_TABLESTEP(tableSize);
    let pos = 0;
    for (let s = 0; s < maxSV1; ++s) {
      const n = norm[s];
      seqSpread.fill(s, pos, pos + 8);
      for (let i = 8; i < n; i += 8) seqSpread.fill(s, pos + i, pos + i + 8);
      pos += n;
    }
    let position = 0;
    for (let s = 0; s < tableSize; s += 2) {
      for (let u = 0; u < 2; ++u) dt.base[(position + u * step) & tableMask] = seqSpread[s + u];
      position = (position + 2 * step) & tableMask;
    }
  } else {
    const tableMask = tableSize - 1;
    const step = FSE_TABLESTEP(tableSize);
    let position = 0;
    for (let s = 0; s < maxSV1; s++) {
      const n = norm[s];
      for (let i = 0; i < n; i++) {
        dt.base[position] = s;
        position = (position + step) & tableMask;
        while (position > highThreshold) position = (position + step) & tableMask;
      }
    }
  }
  for (let u = 0; u < tableSize; u++) {
    const symbol = dt.base[u];
    const nextState = seqSymbolNext[symbol]++;
    const nb = tableLog - highbit32(nextState);
    dt.nbBits[u] = nb;
    dt.nextState[u] = ((nextState << nb) - tableSize) & 0xffff;
    dt.nbAdd[u] = nbAdditionalBits[symbol];
    dt.base[u] = baseValue[symbol];
  }
}

function defaultTable(norm, maxSV, base, bits, log) {
  const t = new SeqTable(log);
  buildFSETable(t, Int16Array.from(norm), maxSV, base, bits, log);
  return t;
}
const LL_defaultDTable = defaultTable(LL_defaultNorm, MaxLL, LL_base, LL_bits, LL_DEFAULTNORMLOG);
const OF_defaultDTable = defaultTable(OF_defaultNorm, 28, OF_base, OF_bits, OF_DEFAULTNORMLOG);
const ML_defaultDTable = defaultTable(ML_defaultNorm, MaxML, ML_base, ML_bits, ML_DEFAULTNORMLOG);

/** ZSTD_buildSeqTable_rle */
function buildSeqTableRle(dt, baseValue, nbAddBits) {
  dt.tableLog = 0;
  dt.fastMode = 0;
  dt.nbBits[0] = 0;
  dt.nextState[0] = 0;
  dt.nbAdd[0] = nbAddBits;
  dt.base[0] = baseValue;
}

const seqNorm = new Int16Array(MaxML + 1);

/** ZSTD_buildSeqTable: returns the size read (or an error); the table used is SEQ_TABLE. */
let SEQ_TABLE = null;

function buildSeqTable(space, current, type, max, maxLog, buf, src, srcSize, baseValue, nbAdditionalBits, defaultDTable, flagRepeatTable) {
  switch (type) {
    case 1: // set_rle
      if (!srcSize) return ERROR(E_srcSize_wrong);
      if (buf[src] > max) return ERROR(E_corruption_detected);
      buildSeqTableRle(space, baseValue[buf[src]], nbAdditionalBits[buf[src]]);
      SEQ_TABLE = space;
      return 1;
    case 0: // set_basic
      SEQ_TABLE = defaultDTable;
      return 0;
    case 3: // set_repeat
      if (!flagRepeatTable) return ERROR(E_corruption_detected);
      SEQ_TABLE = current;
      return 0;
    case 2: {
      // set_compressed
      const headerSize = readNCount(seqNorm, max, buf, src, srcSize);
      if (isError(headerSize)) return ERROR(E_corruption_detected);
      const tableLog = NC_TABLELOG;
      if (tableLog > maxLog) return ERROR(E_corruption_detected);
      buildFSETable(space, seqNorm, NC_MAXSV, baseValue, nbAdditionalBits, tableLog);
      SEQ_TABLE = space;
      return headerSize;
    }
    default:
      return ERROR(E_GENERIC);
  }
}

/* litBufferLocation */
const ZSTD_not_in_dst = 0;
const ZSTD_in_dst = 1;
const ZSTD_split = 2;

const blockSizeMax = (dctx) => (dctx.isFrameDecompression ? dctx.fParams.blockSizeMax : ZSTD_BLOCKSIZE_MAX);

/** ZSTD_getcBlockSize: the size or an error; sets BP_* */
let BP_LAST = 0;
let BP_TYPE = 0;
let BP_ORIGSIZE = 0;

function getcBlockSize(buf, src, srcSize) {
  if (srcSize < ZSTD_blockHeaderSize) return ERROR(E_srcSize_wrong);
  const cBlockHeader = readLE24(buf, src);
  const cSize = cBlockHeader >>> 3;
  BP_LAST = cBlockHeader & 1;
  BP_TYPE = (cBlockHeader >>> 1) & 3;
  BP_ORIGSIZE = cSize;
  if (BP_TYPE === 1) return 1; // bt_rle
  if (BP_TYPE === 3) return ERROR(E_corruption_detected); // bt_reserved
  return cSize;
}

/** ZSTD_allocateLiteralsBuffer */
function allocateLiteralsBuffer(dctx, dstBuf, dst, dstCapacity, litSize, streaming, expectedWriteSize, splitImmediately) {
  const bsMax = blockSizeMax(dctx);
  if (!streaming && dstCapacity > bsMax + WILDCOPY_OVERLENGTH + litSize + WILDCOPY_OVERLENGTH) {
    dctx.litBuf = dstBuf;
    dctx.litBuffer = dst + bsMax + WILDCOPY_OVERLENGTH;
    dctx.litBufferEnd = dctx.litBuffer + litSize;
    dctx.litBufferLocation = ZSTD_in_dst;
  } else if (litSize <= ZSTD_LITBUFFEREXTRASIZE) {
    dctx.litBuf = dctx.litExtraBuffer;
    dctx.litBuffer = 0;
    dctx.litBufferEnd = litSize;
    dctx.litBufferLocation = ZSTD_not_in_dst;
  } else {
    dctx.litBuf = dstBuf;
    if (splitImmediately) {
      dctx.litBuffer = dst + expectedWriteSize - litSize + ZSTD_LITBUFFEREXTRASIZE - WILDCOPY_OVERLENGTH;
      dctx.litBufferEnd = dctx.litBuffer + litSize - ZSTD_LITBUFFEREXTRASIZE;
    } else {
      dctx.litBuffer = dst + expectedWriteSize - litSize;
      dctx.litBufferEnd = dst + expectedWriteSize;
    }
    dctx.litBufferLocation = ZSTD_split;
  }
}

/** ZSTD_decodeLiteralsBlock */
function decodeLiteralsBlock(dctx, buf, istart, srcSize, dstBuf, dst, dstCapacity, streaming) {
  if (srcSize < MIN_CBLOCK_SIZE) return ERROR(E_corruption_detected);
  const litEncType = buf[istart] & 3;
  const bsMax = blockSizeMax(dctx);
  switch (litEncType) {
    case 3: // set_repeat
      if (dctx.litEntropy === 0) return ERROR(E_dictionary_corrupted);
    // fall through
    case 2: {
      // set_compressed
      if (srcSize < 5) return ERROR(E_corruption_detected);
      let lhSize;
      let litSize;
      let litCSize;
      let singleStream = 0;
      const lhlCode = (buf[istart] >> 2) & 3;
      const lhc = readLE32(buf, istart);
      const expectedWriteSize = Math.min(bsMax, dstCapacity);
      switch (lhlCode) {
        case 0:
        case 1:
        default:
          singleStream = !lhlCode ? 1 : 0;
          lhSize = 3;
          litSize = (lhc >>> 4) & 0x3ff;
          litCSize = (lhc >>> 14) & 0x3ff;
          break;
        case 2:
          lhSize = 4;
          litSize = (lhc >>> 4) & 0x3fff;
          litCSize = lhc >>> 18;
          break;
        case 3:
          lhSize = 5;
          litSize = (lhc >>> 4) & 0x3ffff;
          litCSize = (lhc >>> 22) + buf[istart + 4] * 1024;
          break;
      }
      if (litSize > 0 && dstBuf === null) return ERROR(E_dstSize_tooSmall);
      if (litSize > bsMax) return ERROR(E_corruption_detected);
      if (!singleStream && litSize < MIN_LITERALS_FOR_4_STREAMS) return ERROR(E_literals_headerWrong);
      if (litCSize + lhSize > srcSize) return ERROR(E_corruption_detected);
      if (expectedWriteSize < litSize) return ERROR(E_dstSize_tooSmall);
      allocateLiteralsBuffer(dctx, dstBuf, dst, dstCapacity, litSize, streaming, expectedWriteSize, 0);
      const lb = dctx.litBuf;
      let hufSuccess;
      if (litEncType === 3) {
        hufSuccess = singleStream
          ? hufDecompress1XUsingDTable(lb, dctx.litBuffer, litSize, buf, istart + lhSize, litCSize, dctx.HUFptr)
          : hufDecompress4XUsingDTable(lb, dctx.litBuffer, litSize, buf, istart + lhSize, litCSize, dctx.HUFptr);
      } else {
        hufSuccess = singleStream
          ? hufDecompress1X1DCtx(dctx.hufTable, lb, dctx.litBuffer, litSize, buf, istart + lhSize, litCSize)
          : hufDecompress4XHufOnly(dctx.hufTable, lb, dctx.litBuffer, litSize, buf, istart + lhSize, litCSize);
      }
      if (dctx.litBufferLocation === ZSTD_split) {
        dctx.litExtraBuffer.set(lb.subarray(dctx.litBufferEnd - ZSTD_LITBUFFEREXTRASIZE, dctx.litBufferEnd), 0);
        lb.copyWithin(
          dctx.litBuffer + ZSTD_LITBUFFEREXTRASIZE - WILDCOPY_OVERLENGTH,
          dctx.litBuffer,
          dctx.litBuffer + litSize - ZSTD_LITBUFFEREXTRASIZE
        );
        dctx.litBuffer += ZSTD_LITBUFFEREXTRASIZE - WILDCOPY_OVERLENGTH;
        dctx.litBufferEnd -= WILDCOPY_OVERLENGTH;
      }
      if (isError(hufSuccess)) return ERROR(E_corruption_detected);
      dctx.litPtrBuf = lb;
      dctx.litPtr = dctx.litBuffer;
      dctx.litSize = litSize;
      dctx.litEntropy = 1;
      if (litEncType === 2) dctx.HUFptr = dctx.hufTable;
      return litCSize + lhSize;
    }
    case 0: {
      // set_basic
      let litSize;
      let lhSize;
      const lhlCode = (buf[istart] >> 2) & 3;
      const expectedWriteSize = Math.min(bsMax, dstCapacity);
      switch (lhlCode) {
        case 0:
        case 2:
        default:
          lhSize = 1;
          litSize = buf[istart] >> 3;
          break;
        case 1:
          lhSize = 2;
          litSize = readLE16(buf, istart) >> 4;
          break;
        case 3:
          lhSize = 3;
          if (srcSize < 3) return ERROR(E_corruption_detected);
          litSize = readLE24(buf, istart) >> 4;
          break;
      }
      if (litSize > 0 && dstBuf === null) return ERROR(E_dstSize_tooSmall);
      if (litSize > bsMax) return ERROR(E_corruption_detected);
      if (expectedWriteSize < litSize) return ERROR(E_dstSize_tooSmall);
      allocateLiteralsBuffer(dctx, dstBuf, dst, dstCapacity, litSize, streaming, expectedWriteSize, 1);
      if (lhSize + litSize + WILDCOPY_OVERLENGTH > srcSize) {
        if (litSize + lhSize > srcSize) return ERROR(E_corruption_detected);
        const lb = dctx.litBuf;
        if (dctx.litBufferLocation === ZSTD_split) {
          lb.set(buf.subarray(istart + lhSize, istart + lhSize + litSize - ZSTD_LITBUFFEREXTRASIZE), dctx.litBuffer);
          dctx.litExtraBuffer.set(buf.subarray(istart + lhSize + litSize - ZSTD_LITBUFFEREXTRASIZE, istart + lhSize + litSize), 0);
        } else {
          lb.set(buf.subarray(istart + lhSize, istart + lhSize + litSize), dctx.litBuffer);
        }
        dctx.litPtrBuf = lb;
        dctx.litPtr = dctx.litBuffer;
        dctx.litSize = litSize;
        return lhSize + litSize;
      }
      // direct reference into the compressed stream
      dctx.litPtrBuf = buf;
      dctx.litBuf = buf;
      dctx.litPtr = istart + lhSize;
      dctx.litSize = litSize;
      dctx.litBufferEnd = dctx.litPtr + litSize;
      dctx.litBufferLocation = ZSTD_not_in_dst;
      return lhSize + litSize;
    }
    case 1: {
      // set_rle
      const lhlCode = (buf[istart] >> 2) & 3;
      let litSize;
      let lhSize;
      const expectedWriteSize = Math.min(bsMax, dstCapacity);
      switch (lhlCode) {
        case 0:
        case 2:
        default:
          lhSize = 1;
          litSize = buf[istart] >> 3;
          break;
        case 1:
          lhSize = 2;
          if (srcSize < 3) return ERROR(E_corruption_detected);
          litSize = readLE16(buf, istart) >> 4;
          break;
        case 3:
          lhSize = 3;
          if (srcSize < 4) return ERROR(E_corruption_detected);
          litSize = readLE24(buf, istart) >> 4;
          break;
      }
      if (litSize > 0 && dstBuf === null) return ERROR(E_dstSize_tooSmall);
      if (litSize > bsMax) return ERROR(E_corruption_detected);
      if (expectedWriteSize < litSize) return ERROR(E_dstSize_tooSmall);
      allocateLiteralsBuffer(dctx, dstBuf, dst, dstCapacity, litSize, streaming, expectedWriteSize, 1);
      const lb = dctx.litBuf;
      const b = buf[istart + lhSize];
      if (dctx.litBufferLocation === ZSTD_split) {
        lb.fill(b, dctx.litBuffer, dctx.litBuffer + litSize - ZSTD_LITBUFFEREXTRASIZE);
        dctx.litExtraBuffer.fill(b, 0, ZSTD_LITBUFFEREXTRASIZE);
      } else {
        lb.fill(b, dctx.litBuffer, dctx.litBuffer + litSize);
      }
      dctx.litPtrBuf = lb;
      dctx.litPtr = dctx.litBuffer;
      dctx.litSize = litSize;
      return lhSize + 1;
    }
    default:
      return ERROR(E_corruption_detected);
  }
}

/** ZSTD_decodeSeqHeaders: the size read or an error; sets SH_NBSEQ. */
let SH_NBSEQ = 0;

function decodeSeqHeaders(dctx, buf, istart, srcSize) {
  const iend = istart + srcSize;
  let ip = istart;
  if (srcSize < MIN_SEQUENCES_SIZE) return ERROR(E_srcSize_wrong);
  let nbSeq = buf[ip++];
  if (nbSeq > 0x7f) {
    if (nbSeq === 0xff) {
      if (ip + 2 > iend) return ERROR(E_srcSize_wrong);
      nbSeq = readLE16(buf, ip) + LONGNBSEQ;
      ip += 2;
    } else {
      if (ip >= iend) return ERROR(E_srcSize_wrong);
      nbSeq = ((nbSeq - 0x80) << 8) + buf[ip++];
    }
  }
  SH_NBSEQ = nbSeq;
  if (nbSeq === 0) {
    if (ip !== iend) return ERROR(E_corruption_detected);
    return ip - istart;
  }
  if (ip + 1 > iend) return ERROR(E_srcSize_wrong);
  if (buf[ip] & 3) return ERROR(E_corruption_detected);
  const LLtype = buf[ip] >> 6;
  const OFtype = (buf[ip] >> 4) & 3;
  const MLtype = (buf[ip] >> 2) & 3;
  ip++;
  {
    const r = buildSeqTable(dctx.LLTable, dctx.LLTptr, LLtype, MaxLL, LLFSELog, buf, ip, iend - ip, LL_base, LL_bits, LL_defaultDTable, dctx.fseEntropy);
    if (isError(r)) return ERROR(E_corruption_detected);
    dctx.LLTptr = SEQ_TABLE;
    ip += r;
  }
  {
    const r = buildSeqTable(dctx.OFTable, dctx.OFTptr, OFtype, MaxOff, OffFSELog, buf, ip, iend - ip, OF_base, OF_bits, OF_defaultDTable, dctx.fseEntropy);
    if (isError(r)) return ERROR(E_corruption_detected);
    dctx.OFTptr = SEQ_TABLE;
    ip += r;
  }
  {
    const r = buildSeqTable(dctx.MLTable, dctx.MLTptr, MLtype, MaxML, MLFSELog, buf, ip, iend - ip, ML_base, ML_bits, ML_defaultDTable, dctx.fseEntropy);
    if (isError(r)) return ERROR(E_corruption_detected);
    dctx.MLTptr = SEQ_TABLE;
    ip += r;
  }
  return ip - istart;
}

/* seqState_t and seq_t: the sequence being decoded is SEQ_LL, SEQ_ML, SEQ_OFF. */
class SeqState {
  constructor() {
    this.d = new BitD();
    this.llState = 0;
    this.llTable = null;
    this.ofState = 0;
    this.ofTable = null;
    this.mlState = 0;
    this.mlTable = null;
    this.prevOffset = [0, 0, 0];
  }
}
let SEQ_LL = 0;
let SEQ_ML = 0;
let SEQ_OFF = 0;
/* (size_t)-1, the offset a repcode of 0 turns into. */
const SIZE_MAX = 2 ** 64;

/** ZSTD_decodeSequence (64-bit) */
function decodeSequence(st, isLastSeq) {
  const d = st.d;
  const llT = st.llTable;
  const mlT = st.mlTable;
  const ofT = st.ofTable;
  const ll = st.llState;
  const ml = st.mlState;
  const of = st.ofState;
  let matchLength = mlT.base[ml];
  let litLength = llT.base[ll];
  const ofBase = ofT.base[of];
  const llBits = llT.nbAdd[ll];
  const mlBits = mlT.nbAdd[ml];
  const ofBits = ofT.nbAdd[of];
  const totalBits = llBits + mlBits + ofBits;
  const llNext = llT.nextState[ll];
  const mlNext = mlT.nextState[ml];
  const ofNext = ofT.nextState[of];
  const llnbBits = llT.nbBits[ll];
  const mlnbBits = mlT.nbBits[ml];
  const ofnbBits = ofT.nbBits[of];
  const prev = st.prevOffset;
  let offset;
  if (ofBits > 1) {
    offset = ofBase + readBitsFast(d, ofBits);
    prev[2] = prev[1];
    prev[1] = prev[0];
    prev[0] = offset;
  } else {
    const ll0 = llT.base[ll] === 0 ? 1 : 0;
    if (ofBits === 0) {
      offset = prev[ll0];
      prev[1] = prev[ll0 ? 0 : 1];
      prev[0] = offset;
    } else {
      offset = ofBase + ll0 + readBitsFast(d, 1);
      let temp = offset === 3 ? prev[0] - 1 : prev[offset];
      if (temp === 0) temp = SIZE_MAX;
      if (offset !== 1) prev[2] = prev[1];
      prev[1] = prev[0];
      prev[0] = offset = temp;
    }
  }
  if (mlBits > 0) matchLength += readBitsFast(d, mlBits);
  if (totalBits >= STREAM_ACCUMULATOR_MIN_64 - (LLFSELog + MLFSELog + OffFSELog)) reload(d);
  if (llBits > 0) litLength += readBitsFast(d, llBits);
  if (!isLastSeq) {
    st.llState = llNext + readBits(d, llnbBits);
    st.mlState = mlNext + readBits(d, mlnbBits);
    st.ofState = ofNext + readBits(d, ofnbBits);
    reload(d);
  }
  SEQ_LL = litLength;
  SEQ_ML = matchLength;
  SEQ_OFF = offset;
}

function initFseState(st, which, table) {
  const v = readBits(st.d, table.tableLog);
  reload(st.d);
  if (which === 0) {
    st.llState = v;
    st.llTable = table;
  } else if (which === 1) {
    st.ofState = v;
    st.ofTable = table;
  } else {
    st.mlState = v;
    st.mlTable = table;
  }
}

/* The window for one block: the prefix in `ob` (the output buffer) from
 * prefixStart, the extDict ending at dictEnd in dictBuf; virtualStart is in
 * ob's coordinates. */
const W = { ob: null, prefixStart: 0, vBase: 0, dictBuf: null, dictEnd: 0, litBuf: null, litPtr: 0 };

/** Copies a match of `length` from (src) to op in ob, byte by byte as the overlapping C copies do. */
function copyMatch(ob, op, src, length) {
  if (op - src >= length) ob.copyWithin(op, src, src + length);
  else for (let i = 0; i < length; i++) ob[op + i] = ob[src + i];
}

/** Copies literals: they never overlap the output ahead of them. */
function copyLiterals(ob, op, lb, lp, length) {
  if (lb === ob) ob.copyWithin(op, lp, lp + length);
  else ob.set(lb.subarray(lp, lp + length), op);
}

/** The match part of the ZSTD_execSequence* family. */
function execMatch(ob, oLitEnd, offset, matchLength, sequenceLength) {
  let op = oLitEnd;
  if (offset > oLitEnd - W.prefixStart) {
    // offset beyond prefix -> go into extDict
    if (offset > oLitEnd - W.vBase) return ERROR(E_corruption_detected);
    let match = W.dictEnd + (oLitEnd - offset - W.prefixStart);
    if (match + matchLength <= W.dictEnd) {
      if (W.dictBuf === ob) ob.copyWithin(oLitEnd, match, match + matchLength);
      else ob.set(W.dictBuf.subarray(match, match + matchLength), oLitEnd);
      return sequenceLength;
    }
    const length1 = W.dictEnd - match;
    if (W.dictBuf === ob) ob.copyWithin(oLitEnd, match, match + length1);
    else ob.set(W.dictBuf.subarray(match, match + length1), oLitEnd);
    op = oLitEnd + length1;
    matchLength -= length1;
    match = W.prefixStart;
    copyMatch(ob, op, match, matchLength);
    return sequenceLength;
  }
  copyMatch(ob, op, oLitEnd - offset, matchLength);
  return sequenceLength;
}

/** ZSTD_execSequence (with ZSTD_execSequenceEnd for the edge cases) */
function execSequence(ob, op, oend, litLimit) {
  const litLength = SEQ_LL;
  const matchLength = SEQ_ML;
  const offset = SEQ_OFF;
  const oLitEnd = op + litLength;
  const sequenceLength = litLength + matchLength;
  const oMatchEnd = op + sequenceLength;
  const oend_w = oend - WILDCOPY_OVERLENGTH;
  const iLitEnd = W.litPtr + litLength;
  if (iLitEnd > litLimit || oMatchEnd > oend_w) {
    // ZSTD_execSequenceEnd
    if (sequenceLength > oend - op) return ERROR(E_dstSize_tooSmall);
    if (litLength > litLimit - W.litPtr) return ERROR(E_corruption_detected);
  }
  copyLiterals(ob, op, W.litBuf, W.litPtr, litLength);
  W.litPtr = iLitEnd;
  return execMatch(ob, oLitEnd, offset, matchLength, sequenceLength);
}

/** ZSTD_execSequenceSplitLitBuffer (with its End variant) */
function execSequenceSplitLitBuffer(ob, op, oend, oend_w, litLimit) {
  const litLength = SEQ_LL;
  const matchLength = SEQ_ML;
  const offset = SEQ_OFF;
  const oLitEnd = op + litLength;
  const sequenceLength = litLength + matchLength;
  const oMatchEnd = op + sequenceLength;
  const iLitEnd = W.litPtr + litLength;
  if (iLitEnd > litLimit || oMatchEnd > oend_w) {
    // ZSTD_execSequenceEndSplitLitBuffer
    if (sequenceLength > oend - op) return ERROR(E_dstSize_tooSmall);
    if (litLength > litLimit - W.litPtr) return ERROR(E_corruption_detected);
    if (W.litBuf === ob && op > W.litPtr && op < W.litPtr + litLength) return ERROR(E_dstSize_tooSmall);
  }
  copyLiterals(ob, op, W.litBuf, W.litPtr, litLength);
  W.litPtr = iLitEnd;
  return execMatch(ob, oLitEnd, offset, matchLength, sequenceLength);
}

function setWindow(dctx, ob) {
  W.ob = ob;
  W.prefixStart = dctx.prefixStart;
  W.vBase = dctx.virtualStart;
  W.dictBuf = dctx.dictBuf;
  W.dictEnd = dctx.dictEnd;
  W.litBuf = dctx.litPtrBuf;
  W.litPtr = dctx.litPtr;
}

function initSeqState(dctx, st, buf, ip, seqSize) {
  for (let i = 0; i < ZSTD_REP_NUM; i++) st.prevOffset[i] = dctx.rep[i];
  if (isError(bitInit(st.d, buf, ip, seqSize))) return ERROR(E_corruption_detected);
  initFseState(st, 0, dctx.LLTptr);
  initFseState(st, 1, dctx.OFTptr);
  initFseState(st, 2, dctx.MLTptr);
  return 0;
}

/** (U32)prevOffset */
const toU32 = (v) => (v >= SIZE_MAX ? 0xffffffff : v >>> 0);

/** ZSTD_decompressSequences_body */
function decompressSequences(dctx, ob, ostart, maxDstSize, buf, ip, seqSize, nbSeq) {
  const oend = dctx.litBufferLocation === ZSTD_not_in_dst ? ostart + maxDstSize : dctx.litBuffer;
  let op = ostart;
  setWindow(dctx, ob);
  const litEnd = W.litPtr + dctx.litSize;
  if (nbSeq) {
    const st = new SeqState();
    dctx.fseEntropy = 1;
    const r = initSeqState(dctx, st, buf, ip, seqSize);
    if (isError(r)) return r;
    for (; nbSeq; nbSeq--) {
      decodeSequence(st, nbSeq === 1);
      const oneSeqSize = execSequence(ob, op, oend, litEnd);
      if (isError(oneSeqSize)) return oneSeqSize;
      op += oneSeqSize;
    }
    if (!endOfDStream(st.d)) return ERROR(E_corruption_detected);
    for (let i = 0; i < ZSTD_REP_NUM; i++) dctx.rep[i] = toU32(st.prevOffset[i]);
  }
  {
    const lastLLSize = litEnd - W.litPtr;
    if (lastLLSize > oend - op) return ERROR(E_dstSize_tooSmall);
    copyLiterals(ob, op, W.litBuf, W.litPtr, lastLLSize);
    op += lastLLSize;
  }
  return op - ostart;
}

/** ZSTD_decompressSequences_bodySplitLitBuffer */
function decompressSequencesSplitLitBuffer(dctx, ob, ostart, maxDstSize, buf, ip, seqSize, nbSeq) {
  const oend = ostart + maxDstSize;
  let op = ostart;
  setWindow(dctx, ob);
  let litBufferEnd = dctx.litBufferEnd;
  if (nbSeq) {
    const st = new SeqState();
    dctx.fseEntropy = 1;
    const r = initSeqState(dctx, st, buf, ip, seqSize);
    if (isError(r)) return r;
    let pendingLL = 0;
    let pendingML = 0;
    let pendingOFF = 0;
    let stopped = false;
    for (; nbSeq; nbSeq--) {
      decodeSequence(st, nbSeq === 1);
      if (W.litPtr + SEQ_LL > dctx.litBufferEnd) {
        stopped = true;
        pendingLL = SEQ_LL;
        pendingML = SEQ_ML;
        pendingOFF = SEQ_OFF;
        break;
      }
      const oneSeqSize = execSequenceSplitLitBuffer(ob, op, oend, W.litPtr + SEQ_LL - WILDCOPY_OVERLENGTH, litBufferEnd);
      if (isError(oneSeqSize)) return oneSeqSize;
      op += oneSeqSize;
    }
    if (nbSeq > 0) {
      // `stopped` is necessarily set here.
      void stopped;
      const leftoverLit = dctx.litBufferEnd - W.litPtr;
      if (leftoverLit) {
        if (leftoverLit > oend - op) return ERROR(E_dstSize_tooSmall);
        copyLiterals(ob, op, W.litBuf, W.litPtr, leftoverLit);
        pendingLL -= leftoverLit;
        op += leftoverLit;
      }
      W.litBuf = dctx.litExtraBuffer;
      W.litPtr = 0;
      litBufferEnd = ZSTD_LITBUFFEREXTRASIZE;
      dctx.litBufferLocation = ZSTD_not_in_dst;
      SEQ_LL = pendingLL;
      SEQ_ML = pendingML;
      SEQ_OFF = pendingOFF;
      const oneSeqSize = execSequence(ob, op, oend, litBufferEnd);
      if (isError(oneSeqSize)) return oneSeqSize;
      op += oneSeqSize;
      nbSeq--;
    }
    if (nbSeq > 0) {
      for (; nbSeq; nbSeq--) {
        decodeSequence(st, nbSeq === 1);
        const oneSeqSize = execSequence(ob, op, oend, litBufferEnd);
        if (isError(oneSeqSize)) return oneSeqSize;
        op += oneSeqSize;
      }
    }
    if (nbSeq) return ERROR(E_corruption_detected);
    if (!endOfDStream(st.d)) return ERROR(E_corruption_detected);
    for (let i = 0; i < ZSTD_REP_NUM; i++) dctx.rep[i] = toU32(st.prevOffset[i]);
  }
  if (dctx.litBufferLocation === ZSTD_split) {
    const lastLLSize = litBufferEnd - W.litPtr;
    if (lastLLSize > oend - op) return ERROR(E_dstSize_tooSmall);
    copyLiterals(ob, op, W.litBuf, W.litPtr, lastLLSize);
    op += lastLLSize;
    W.litBuf = dctx.litExtraBuffer;
    W.litPtr = 0;
    litBufferEnd = ZSTD_LITBUFFEREXTRASIZE;
    dctx.litBufferLocation = ZSTD_not_in_dst;
  }
  {
    const lastLLSize = litBufferEnd - W.litPtr;
    if (lastLLSize > oend - op) return ERROR(E_dstSize_tooSmall);
    copyLiterals(ob, op, W.litBuf, W.litPtr, lastLLSize);
    op += lastLLSize;
  }
  return op - ostart;
}

/** ZSTD_decompressSequencesLong_body */
function decompressSequencesLong(dctx, ob, ostart, maxDstSize, buf, ip, seqSize, nbSeq) {
  const oend = dctx.litBufferLocation === ZSTD_in_dst ? dctx.litBuffer : ostart + maxDstSize;
  let op = ostart;
  setWindow(dctx, ob);
  let litBufferEnd = dctx.litBufferEnd;
  if (nbSeq) {
    const STORED = 8;
    const MASK8 = 7;
    const qLL = new Float64Array(STORED);
    const qML = new Float64Array(STORED);
    const qOFF = new Float64Array(STORED);
    const seqAdvance = Math.min(nbSeq, STORED);
    const st = new SeqState();
    let seqNb;
    dctx.fseEntropy = 1;
    const r = initSeqState(dctx, st, buf, ip, seqSize);
    if (isError(r)) return r;
    for (seqNb = 0; seqNb < seqAdvance; seqNb++) {
      decodeSequence(st, seqNb === nbSeq - 1);
      qLL[seqNb] = SEQ_LL;
      qML[seqNb] = SEQ_ML;
      qOFF[seqNb] = SEQ_OFF;
    }
    const run = (k) => {
      SEQ_LL = qLL[k];
      SEQ_ML = qML[k];
      SEQ_OFF = qOFF[k];
    };
    for (; seqNb < nbSeq; seqNb++) {
      decodeSequence(st, seqNb === nbSeq - 1);
      const nLL = SEQ_LL;
      const nML = SEQ_ML;
      const nOFF = SEQ_OFF;
      const k = (seqNb - STORED) & MASK8;
      if (dctx.litBufferLocation === ZSTD_split && W.litPtr + qLL[k] > dctx.litBufferEnd) {
        const leftoverLit = dctx.litBufferEnd - W.litPtr;
        if (leftoverLit) {
          if (leftoverLit > oend - op) return ERROR(E_dstSize_tooSmall);
          copyLiterals(ob, op, W.litBuf, W.litPtr, leftoverLit);
          qLL[k] -= leftoverLit;
          op += leftoverLit;
        }
        W.litBuf = dctx.litExtraBuffer;
        W.litPtr = 0;
        litBufferEnd = ZSTD_LITBUFFEREXTRASIZE;
        dctx.litBufferLocation = ZSTD_not_in_dst;
        run(k);
        const oneSeqSize = execSequence(ob, op, oend, litBufferEnd);
        if (isError(oneSeqSize)) return oneSeqSize;
        qLL[seqNb & MASK8] = nLL;
        qML[seqNb & MASK8] = nML;
        qOFF[seqNb & MASK8] = nOFF;
        op += oneSeqSize;
      } else {
        run(k);
        const oneSeqSize =
          dctx.litBufferLocation === ZSTD_split
            ? execSequenceSplitLitBuffer(ob, op, oend, W.litPtr + qLL[k] - WILDCOPY_OVERLENGTH, litBufferEnd)
            : execSequence(ob, op, oend, litBufferEnd);
        if (isError(oneSeqSize)) return oneSeqSize;
        qLL[seqNb & MASK8] = nLL;
        qML[seqNb & MASK8] = nML;
        qOFF[seqNb & MASK8] = nOFF;
        op += oneSeqSize;
      }
    }
    if (!endOfDStream(st.d)) return ERROR(E_corruption_detected);
    seqNb -= seqAdvance;
    for (; seqNb < nbSeq; seqNb++) {
      const k = seqNb & MASK8;
      if (dctx.litBufferLocation === ZSTD_split && W.litPtr + qLL[k] > dctx.litBufferEnd) {
        const leftoverLit = dctx.litBufferEnd - W.litPtr;
        if (leftoverLit) {
          if (leftoverLit > oend - op) return ERROR(E_dstSize_tooSmall);
          copyLiterals(ob, op, W.litBuf, W.litPtr, leftoverLit);
          qLL[k] -= leftoverLit;
          op += leftoverLit;
        }
        W.litBuf = dctx.litExtraBuffer;
        W.litPtr = 0;
        litBufferEnd = ZSTD_LITBUFFEREXTRASIZE;
        dctx.litBufferLocation = ZSTD_not_in_dst;
        run(k);
        const oneSeqSize = execSequence(ob, op, oend, litBufferEnd);
        if (isError(oneSeqSize)) return oneSeqSize;
        op += oneSeqSize;
      } else {
        run(k);
        const oneSeqSize =
          dctx.litBufferLocation === ZSTD_split
            ? execSequenceSplitLitBuffer(ob, op, oend, W.litPtr + qLL[k] - WILDCOPY_OVERLENGTH, litBufferEnd)
            : execSequence(ob, op, oend, litBufferEnd);
        if (isError(oneSeqSize)) return oneSeqSize;
        op += oneSeqSize;
      }
    }
    for (let i = 0; i < ZSTD_REP_NUM; i++) dctx.rep[i] = toU32(st.prevOffset[i]);
  }
  if (dctx.litBufferLocation === ZSTD_split) {
    const lastLLSize = litBufferEnd - W.litPtr;
    if (lastLLSize > oend - op) return ERROR(E_dstSize_tooSmall);
    copyLiterals(ob, op, W.litBuf, W.litPtr, lastLLSize);
    op += lastLLSize;
    W.litBuf = dctx.litExtraBuffer;
    W.litPtr = 0;
    litBufferEnd = ZSTD_LITBUFFEREXTRASIZE;
  }
  {
    const lastLLSize = litBufferEnd - W.litPtr;
    if (lastLLSize > oend - op) return ERROR(E_dstSize_tooSmall);
    copyLiterals(ob, op, W.litBuf, W.litPtr, lastLLSize);
    op += lastLLSize;
  }
  return op - ostart;
}

/** ZSTD_getOffsetInfo */
function getOffsetInfo(offTable, nbSeq) {
  let longOffsetShare = 0;
  let maxNbAdditionalBits = 0;
  if (nbSeq !== 0) {
    const tableLog = offTable.tableLog;
    const max = 1 << tableLog;
    for (let u = 0; u < max; u++) {
      maxNbAdditionalBits = Math.max(maxNbAdditionalBits, offTable.nbAdd[u]);
      if (offTable.nbAdd[u] > 22) longOffsetShare += 1;
    }
    longOffsetShare <<= OffFSELog - tableLog;
  }
  return { longOffsetShare, maxNbAdditionalBits };
}

/** ZSTD_decompressBlock_internal */
function decompressBlockInternal(dctx, ob, dst, dstCapacity, buf, ip, srcSize, streaming) {
  if (srcSize > blockSizeMax(dctx)) return ERROR(E_srcSize_wrong);
  {
    const litCSize = decodeLiteralsBlock(dctx, buf, ip, srcSize, ob, dst, dstCapacity, streaming);
    if (isError(litCSize)) return litCSize;
    ip += litCSize;
    srcSize -= litCSize;
  }
  {
    const bsMax = Math.min(dstCapacity, blockSizeMax(dctx));
    const totalHistorySize = dst + bsMax - dctx.virtualStart;
    let usePrefetchDecoder = dctx.ddictIsCold;
    const seqHSize = decodeSeqHeaders(dctx, buf, ip, srcSize);
    if (isError(seqHSize)) return seqHSize;
    const nbSeq = SH_NBSEQ;
    ip += seqHSize;
    srcSize -= seqHSize;
    if ((ob === null || dstCapacity === 0) && nbSeq > 0) return ERROR(E_dstSize_tooSmall);
    if (!usePrefetchDecoder && totalHistorySize > 1 << 24 && nbSeq > 8) {
      const info = getOffsetInfo(dctx.OFTptr, nbSeq);
      usePrefetchDecoder = info.longOffsetShare >= 7 ? 1 : 0;
    }
    dctx.ddictIsCold = 0;
    if (usePrefetchDecoder) return decompressSequencesLong(dctx, ob, dst, dstCapacity, buf, ip, srcSize, nbSeq);
    if (dctx.litBufferLocation === ZSTD_split) {
      return decompressSequencesSplitLitBuffer(dctx, ob, dst, dstCapacity, buf, ip, srcSize, nbSeq);
    }
    return decompressSequences(dctx, ob, dst, dstCapacity, buf, ip, srcSize, nbSeq);
  }
}

/** ZSTD_checkContinuity */
function checkContinuity(dctx, dstBuf, dst, dstSize) {
  if (!(dstBuf === dctx.prevBuf && dst === dctx.previousDstEnd) && dstSize > 0) {
    dctx.dictBuf = dctx.prevBuf;
    dctx.dictEnd = dctx.previousDstEnd;
    dctx.virtualStart = dst - (dctx.previousDstEnd - dctx.prefixStart);
    dctx.prefixBuf = dstBuf;
    dctx.prefixStart = dst;
    dctx.prevBuf = dstBuf;
    dctx.previousDstEnd = dst;
  }
}

/* zstd_decompress.c */

/* ZSTD_dStage */
const ZSTDds_getFrameHeaderSize = 0;
const ZSTDds_decodeFrameHeader = 1;
const ZSTDds_decodeBlockHeader = 2;
const ZSTDds_decompressBlock = 3;
const ZSTDds_decompressLastBlock = 4;
const ZSTDds_checkChecksum = 5;
const ZSTDds_decodeSkippableHeader = 6;
const ZSTDds_skipFrame = 7;
/* ZSTD_dStreamStage */
const zdss_init = 0;
const zdss_loadHeader = 1;
const zdss_read = 2;
const zdss_load = 3;
const zdss_flush = 4;
/* dictUses */
const ZSTD_use_indefinitely = -1;
const ZSTD_dont_use = 0;
const ZSTD_use_once = 1;
/* blockType_e */
const bt_raw = 0;
const bt_rle = 1;
const bt_compressed = 2;

/** The decoding tables of a context or a DDict (ZSTD_entropyDTables_t). */
function newEntropy() {
  return {
    LLTable: new SeqTable(LLFSELog),
    OFTable: new SeqTable(OffFSELog),
    MLTable: new SeqTable(MLFSELog),
    hufTable: new HufDTable(),
    rep: [0, 0, 0],
  };
}

class FrameHeader {
  constructor() {
    this.frameContentSize = 0;
    this.windowSize = 0;
    this.blockSizeMax = 0;
    this.frameType = 0; // ZSTD_frame, 1: ZSTD_skippableFrame
    this.headerSize = 0;
    this.dictID = 0;
    this.checksumFlag = 0;
  }
}

/** ZSTD_frameHeaderSize_internal (ZSTD_f_zstd1) */
function frameHeaderSize(buf, src, srcSize) {
  if (srcSize < ZSTD_FRAMEHEADERSIZE_PREFIX) return ERROR(E_srcSize_wrong);
  const fhd = buf[src + ZSTD_FRAMEHEADERSIZE_PREFIX - 1];
  const dictID = fhd & 3;
  const singleSegment = (fhd >> 5) & 1;
  const fcsId = fhd >> 6;
  return (
    ZSTD_FRAMEHEADERSIZE_PREFIX +
    (singleSegment ? 0 : 1) +
    ZSTD_did_fieldSize[dictID] +
    ZSTD_fcs_fieldSize[fcsId] +
    (singleSegment && !fcsId ? 1 : 0)
  );
}

/** A 64-bit little-endian frame content size; 2^64 - 1 is "unknown". */
function readFcs64(buf, p) {
  const lo = readLE32(buf, p);
  const hi = readLE32(buf, p + 4);
  if (lo === 0xffffffff && hi === 0xffffffff) return CONTENTSIZE_UNKNOWN;
  return hi * 2 ** 32 + lo;
}

/** ZSTD_getFrameHeader_advanced (ZSTD_f_zstd1): 0, the size wanted, or an error. */
function getFrameHeader(zfh, buf, src, srcSize) {
  const minInputSize = ZSTD_FRAMEHEADERSIZE_PREFIX;
  if (srcSize < minInputSize) {
    if (srcSize > 0) {
      const toCopy = Math.min(4, srcSize);
      const hbuf = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
      hbuf.set(buf.subarray(src, src + toCopy));
      if (readLE32(hbuf, 0) !== ZSTD_MAGICNUMBER) {
        hbuf.set([0x50, 0x2a, 0x4d, 0x18]);
        hbuf.set(buf.subarray(src, src + toCopy));
        if ((readLE32(hbuf, 0) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 !== ZSTD_MAGIC_SKIPPABLE_START) {
          return ERROR(E_prefix_unknown);
        }
      }
    }
    return minInputSize;
  }
  Object.assign(zfh, new FrameHeader());
  if (readLE32(buf, src) !== ZSTD_MAGICNUMBER) {
    if ((readLE32(buf, src) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 === ZSTD_MAGIC_SKIPPABLE_START) {
      if (srcSize < ZSTD_SKIPPABLEHEADERSIZE) return ZSTD_SKIPPABLEHEADERSIZE;
      Object.assign(zfh, new FrameHeader());
      zfh.frameType = 1;
      zfh.dictID = (readLE32(buf, src) - ZSTD_MAGIC_SKIPPABLE_START) >>> 0;
      zfh.headerSize = ZSTD_SKIPPABLEHEADERSIZE;
      zfh.frameContentSize = readLE32(buf, src + ZSTD_FRAMEIDSIZE);
      return 0;
    }
    return ERROR(E_prefix_unknown);
  }
  {
    const fhsize = frameHeaderSize(buf, src, srcSize);
    if (srcSize < fhsize) return fhsize;
    zfh.headerSize = fhsize;
  }
  {
    const fhdByte = buf[src + minInputSize - 1];
    let pos = minInputSize;
    const dictIDSizeCode = fhdByte & 3;
    const checksumFlag = (fhdByte >> 2) & 1;
    const singleSegment = (fhdByte >> 5) & 1;
    const fcsID = fhdByte >> 6;
    let windowSize = 0;
    let dictID = 0;
    let frameContentSize = CONTENTSIZE_UNKNOWN;
    if ((fhdByte & 0x08) !== 0) return ERROR(E_frameParameter_unsupported);
    if (!singleSegment) {
      const wlByte = buf[src + pos++];
      const windowLog = (wlByte >> 3) + ZSTD_WINDOWLOG_ABSOLUTEMIN;
      if (windowLog > ZSTD_WINDOWLOG_MAX) return ERROR(E_frameParameter_windowTooLarge);
      windowSize = 2 ** windowLog;
      windowSize += (windowSize / 8) * (wlByte & 7);
    }
    switch (dictIDSizeCode) {
      default:
      case 0:
        break;
      case 1:
        dictID = buf[src + pos];
        pos++;
        break;
      case 2:
        dictID = readLE16(buf, src + pos);
        pos += 2;
        break;
      case 3:
        dictID = readLE32(buf, src + pos);
        pos += 4;
        break;
    }
    switch (fcsID) {
      default:
      case 0:
        if (singleSegment) frameContentSize = buf[src + pos];
        break;
      case 1:
        frameContentSize = readLE16(buf, src + pos) + 256;
        break;
      case 2:
        frameContentSize = readLE32(buf, src + pos);
        break;
      case 3:
        frameContentSize = readFcs64(buf, src + pos);
        break;
    }
    if (singleSegment) windowSize = frameContentSize === CONTENTSIZE_UNKNOWN ? 2 ** 64 : frameContentSize;
    zfh.frameType = 0;
    zfh.frameContentSize = frameContentSize;
    zfh.windowSize = windowSize;
    zfh.blockSizeMax = Math.min(windowSize, ZSTD_BLOCKSIZE_MAX);
    zfh.dictID = dictID;
    zfh.checksumFlag = checksumFlag;
  }
  return 0;
}

/** readSkippableFrameSize */
function readSkippableFrameSize(buf, src, srcSize) {
  if (srcSize < ZSTD_SKIPPABLEHEADERSIZE) return ERROR(E_srcSize_wrong);
  const sizeU32 = readLE32(buf, src + ZSTD_FRAMEIDSIZE);
  if (((sizeU32 + ZSTD_SKIPPABLEHEADERSIZE) >>> 0) < sizeU32) return ERROR(E_frameParameter_unsupported);
  const skippableSize = ZSTD_SKIPPABLEHEADERSIZE + sizeU32;
  if (skippableSize > srcSize) return ERROR(E_srcSize_wrong);
  return skippableSize;
}

/** ZSTD_findFrameCompressedSize (ZSTD_findFrameSizeInfo's compressedSize) */
function findFrameCompressedSize(buf, src, srcSize) {
  if (srcSize >= ZSTD_SKIPPABLEHEADERSIZE && (readLE32(buf, src) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 === ZSTD_MAGIC_SKIPPABLE_START) {
    return readSkippableFrameSize(buf, src, srcSize);
  }
  let ip = src;
  let remainingSize = srcSize;
  const zfh = new FrameHeader();
  {
    const ret = getFrameHeader(zfh, buf, src, srcSize);
    if (isError(ret)) return ret;
    if (ret > 0) return ERROR(E_srcSize_wrong);
  }
  ip += zfh.headerSize;
  remainingSize -= zfh.headerSize;
  for (;;) {
    const cBlockSize = getcBlockSize(buf, ip, remainingSize);
    if (isError(cBlockSize)) return cBlockSize;
    if (ZSTD_blockHeaderSize + cBlockSize > remainingSize) return ERROR(E_srcSize_wrong);
    ip += ZSTD_blockHeaderSize + cBlockSize;
    remainingSize -= ZSTD_blockHeaderSize + cBlockSize;
    if (BP_LAST) break;
  }
  if (zfh.checksumFlag) {
    if (remainingSize < 4) return ERROR(E_srcSize_wrong);
    ip += 4;
  }
  return ip - src;
}

/** ZSTD_DDict */
class DDict {
  constructor(dict) {
    this.dictContent = Uint8Array.from(dict);
    this.dictSize = this.dictContent.length;
    this.entropy = newEntropy();
    this.dictID = 0;
    this.entropyPresent = 0;
  }
}

/** ZSTD_loadDEntropy: the size of the tables, or an error. */
function loadDEntropy(entropy, buf, dict, dictSize) {
  let dictPtr = dict;
  const dictEnd = dict + dictSize;
  if (dictSize <= 8) return ERROR(E_dictionary_corrupted);
  dictPtr += 8;
  {
    // The FSE tables serve as the workspace: their size.
    const workspaceSize = 8 * ((1 + (1 << LLFSELog)) + (1 + (1 << OffFSELog)) + (1 + (1 << MLFSELog)));
    const hSize = hufReadDTableX2(entropy.hufTable, buf, dictPtr, dictEnd - dictPtr, workspaceSize);
    if (isError(hSize)) return ERROR(E_dictionary_corrupted);
    dictPtr += hSize;
  }
  const loadTable = (table, max, maxLog, base, bits) => {
    const norm = new Int16Array(max + 1);
    const headerSize = readNCount(norm, max, buf, dictPtr, dictEnd - dictPtr);
    if (isError(headerSize)) return ERROR(E_dictionary_corrupted);
    if (NC_MAXSV > max) return ERROR(E_dictionary_corrupted);
    if (NC_TABLELOG > maxLog) return ERROR(E_dictionary_corrupted);
    buildFSETable(table, norm, NC_MAXSV, base, bits, NC_TABLELOG);
    dictPtr += headerSize;
    return 0;
  };
  let r = loadTable(entropy.OFTable, MaxOff, OffFSELog, OF_base, OF_bits);
  if (isError(r)) return r;
  r = loadTable(entropy.MLTable, MaxML, MLFSELog, ML_base, ML_bits);
  if (isError(r)) return r;
  r = loadTable(entropy.LLTable, MaxLL, LLFSELog, LL_base, LL_bits);
  if (isError(r)) return r;
  if (dictPtr + 12 > dictEnd) return ERROR(E_dictionary_corrupted);
  {
    const dictContentSize = dictEnd - (dictPtr + 12);
    for (let i = 0; i < 3; i++) {
      const rep = readLE32(buf, dictPtr);
      dictPtr += 4;
      if (rep === 0 || rep > dictContentSize) return ERROR(E_dictionary_corrupted);
      entropy.rep[i] = rep;
    }
  }
  return dictPtr - dict;
}

/** ZSTD_createDDict_advanced(byCopy, ZSTD_dct_auto): the DDict, or null. */
function createDDict(dict) {
  const ddict = new DDict(dict);
  ddict.entropy.hufTable.init();
  // ZSTD_loadEntropy_intoDDict
  ddict.dictID = 0;
  ddict.entropyPresent = 0;
  if (ddict.dictSize < 8) return ddict;
  if (readLE32(ddict.dictContent, 0) !== ZSTD_MAGIC_DICTIONARY) return ddict;
  ddict.dictID = readLE32(ddict.dictContent, ZSTD_FRAMEIDSIZE);
  if (isError(loadDEntropy(ddict.entropy, ddict.dictContent, 0, ddict.dictSize))) return null;
  ddict.entropyPresent = 1;
  return ddict;
}

/** ZSTD_DCtx (a ZSTD_DStream) */
export class DCtx {
  constructor() {
    // ZSTD_initDCtx_internal
    this.ddict = null;
    this.ddictLocal = null;
    this.prevBuf = null;
    this.previousDstEnd = 0;
    this.prefixBuf = null;
    this.prefixStart = 0;
    this.virtualStart = 0;
    this.dictBuf = null;
    this.dictEnd = 0;
    this.ddictIsCold = 0;
    this.dictUses = ZSTD_dont_use;
    this.inBuff = null;
    this.inBuffSize = 0;
    this.outBuff = null;
    this.outBuffSize = 0;
    this.streamStage = zdss_init;
    this.noForwardProgress = 0;
    this.oversizedDuration = 0;
    this.isFrameDecompression = 1;
    // ZSTD_DCtx_resetParameters
    this.maxWindowSize = ZSTD_MAXWINDOWSIZE_DEFAULT;
    this.forceIgnoreChecksum = 0;
    this.maxBlockSizeParam = 0;
    // The rest of the context.
    const entropy = newEntropy();
    this.LLTable = entropy.LLTable;
    this.OFTable = entropy.OFTable;
    this.MLTable = entropy.MLTable;
    this.hufTable = entropy.hufTable;
    this.rep = entropy.rep;
    this.LLTptr = this.LLTable;
    this.OFTptr = this.OFTable;
    this.MLTptr = this.MLTable;
    this.HUFptr = this.hufTable;
    this.litExtraBuffer = new Uint8Array(ZSTD_LITBUFFEREXTRASIZE + WILDCOPY_OVERLENGTH);
    this.litBuf = null;
    this.litBuffer = 0;
    this.litBufferEnd = 0;
    this.litBufferLocation = ZSTD_not_in_dst;
    this.litPtrBuf = null;
    this.litPtr = 0;
    this.litSize = 0;
    this.litEntropy = 0;
    this.fseEntropy = 0;
    this.fParams = new FrameHeader();
    this.headerBuffer = new Uint8Array(18);
    this.xxhState = new XXH64State();
    this.validateChecksum = 0;
    this.expected = 0;
    this.stage = ZSTDds_getFrameHeaderSize;
    this.processedCSize = 0;
    this.decodedSize = 0;
    this.bType = 0;
    this.rleSize = 0;
    this.headerSize = 0;
    this.dictID = 0;
    this.lhSize = 0;
    this.inPos = 0;
    this.outStart = 0;
    this.outEnd = 0;
    this.hostageByte = 0;
  }
}

function clearDict(dctx) {
  dctx.ddictLocal = null;
  dctx.ddict = null;
  dctx.dictUses = ZSTD_dont_use;
}

/** ZSTD_DCtx_loadDictionary: 0 or an error. */
export function loadDictionary(dctx, dict) {
  if (dctx.streamStage !== zdss_init) return ERROR(E_stage_wrong);
  clearDict(dctx);
  if (dict && dict.length !== 0) {
    dctx.ddictLocal = createDDict(dict);
    if (dctx.ddictLocal === null) return ERROR(E_memory_allocation);
    dctx.ddict = dctx.ddictLocal;
    dctx.dictUses = ZSTD_use_indefinitely;
  }
  return 0;
}

/** ZSTD_DCtx_setParameter: 0 or an error. */
export function setParameter(dctx, param, value) {
  if (dctx.streamStage !== zdss_init) return ERROR(E_stage_wrong);
  const within = (lo, hi) => value >= lo && value <= hi;
  switch (param) {
    case 100: // ZSTD_d_windowLogMax
      if (value === 0) value = ZSTD_WINDOWLOG_LIMIT_DEFAULT;
      if (!within(ZSTD_WINDOWLOG_ABSOLUTEMIN, ZSTD_WINDOWLOG_MAX)) return ERROR(E_parameter_outOfBound);
      dctx.maxWindowSize = 2 ** value;
      return 0;
    case 1000: // ZSTD_d_format
      if (!within(0, 1)) return ERROR(E_parameter_outOfBound);
      return value === 0 ? 0 : ERROR(E_parameter_unsupported);
    case 1001: // ZSTD_d_stableOutBuffer
      if (!within(0, 1)) return ERROR(E_parameter_outOfBound);
      return value === 0 ? 0 : ERROR(E_parameter_unsupported);
    case 1002: // ZSTD_d_forceIgnoreChecksum
      if (!within(0, 1)) return ERROR(E_parameter_outOfBound);
      dctx.forceIgnoreChecksum = value;
      return 0;
    case 1003: // ZSTD_d_refMultipleDDicts
      if (!within(0, 1)) return ERROR(E_parameter_outOfBound);
      return value === 0 ? 0 : ERROR(E_parameter_unsupported);
    case 1004: // ZSTD_d_disableHuffmanAssembly
      if (!within(0, 1)) return ERROR(E_parameter_outOfBound);
      return 0;
    case 1005: // ZSTD_d_maxBlockSize
      if (value !== 0 && !within(ZSTD_BLOCKSIZE_MAX_MIN, ZSTD_BLOCKSIZE_MAX)) return ERROR(E_parameter_outOfBound);
      dctx.maxBlockSizeParam = value;
      return 0;
    default:
      return ERROR(E_parameter_unsupported);
  }
}

/** ZSTD_decompressBegin */
function decompressBegin(dctx) {
  dctx.expected = ZSTD_FRAMEHEADERSIZE_PREFIX;
  dctx.stage = ZSTDds_getFrameHeaderSize;
  dctx.processedCSize = 0;
  dctx.decodedSize = 0;
  dctx.prevBuf = null;
  dctx.previousDstEnd = 0;
  dctx.prefixBuf = null;
  dctx.prefixStart = 0;
  dctx.virtualStart = 0;
  dctx.dictBuf = null;
  dctx.dictEnd = 0;
  dctx.hufTable.init();
  dctx.litEntropy = dctx.fseEntropy = 0;
  dctx.dictID = 0;
  dctx.bType = 3;
  dctx.isFrameDecompression = 1;
  for (let i = 0; i < 3; i++) dctx.rep[i] = repStartValue[i];
  dctx.LLTptr = dctx.LLTable;
  dctx.MLTptr = dctx.MLTable;
  dctx.OFTptr = dctx.OFTable;
  dctx.HUFptr = dctx.hufTable;
  return 0;
}

/** ZSTD_decompressBegin_usingDDict */
function decompressBeginUsingDDict(dctx, ddict) {
  if (ddict) {
    const dictEnd = ddict.dictSize;
    dctx.ddictIsCold = dctx.dictBuf === ddict.dictContent && dctx.dictEnd === dictEnd ? 0 : 1;
  }
  decompressBegin(dctx);
  if (ddict) {
    // ZSTD_copyDDictParameters
    dctx.dictID = ddict.dictID;
    dctx.prefixBuf = ddict.dictContent;
    dctx.prefixStart = 0;
    dctx.virtualStart = 0;
    dctx.dictBuf = ddict.dictContent;
    dctx.dictEnd = ddict.dictSize;
    dctx.prevBuf = ddict.dictContent;
    dctx.previousDstEnd = ddict.dictSize;
    if (ddict.entropyPresent) {
      dctx.litEntropy = 1;
      dctx.fseEntropy = 1;
      dctx.LLTptr = ddict.entropy.LLTable;
      dctx.MLTptr = ddict.entropy.MLTable;
      dctx.OFTptr = ddict.entropy.OFTable;
      dctx.HUFptr = ddict.entropy.hufTable;
      dctx.rep[0] = ddict.entropy.rep[0];
      dctx.rep[1] = ddict.entropy.rep[1];
      dctx.rep[2] = ddict.entropy.rep[2];
    } else {
      dctx.litEntropy = 0;
      dctx.fseEntropy = 0;
    }
  }
  return 0;
}

/** ZSTD_getDDict */
function getDDict(dctx) {
  switch (dctx.dictUses) {
    default:
    case ZSTD_dont_use:
      clearDict(dctx);
      return null;
    case ZSTD_use_indefinitely:
      return dctx.ddict;
    case ZSTD_use_once:
      dctx.dictUses = ZSTD_dont_use;
      return dctx.ddict;
  }
}

/** ZSTD_decodeFrameHeader */
function decodeFrameHeader(dctx, buf, src, headerSize) {
  const result = getFrameHeader(dctx.fParams, buf, src, headerSize);
  if (isError(result)) return result;
  if (result > 0) return ERROR(E_srcSize_wrong);
  if (dctx.fParams.dictID && dctx.dictID !== dctx.fParams.dictID) return ERROR(E_dictionary_wrong);
  dctx.validateChecksum = dctx.fParams.checksumFlag && !dctx.forceIgnoreChecksum ? 1 : 0;
  if (dctx.validateChecksum) dctx.xxhState.reset();
  dctx.processedCSize += headerSize;
  return 0;
}

function copyRawBlock(dstBuf, dst, dstCapacity, buf, src, srcSize) {
  if (srcSize > dstCapacity) return ERROR(E_dstSize_tooSmall);
  if (dstBuf === null) {
    if (srcSize === 0) return 0;
    return ERROR(E_dstBuffer_null);
  }
  if (dstBuf === buf) dstBuf.copyWithin(dst, src, src + srcSize);
  else dstBuf.set(buf.subarray(src, src + srcSize), dst);
  return srcSize;
}

function setRleBlock(dstBuf, dst, dstCapacity, b, regenSize) {
  if (regenSize > dstCapacity) return ERROR(E_dstSize_tooSmall);
  if (dstBuf === null) {
    if (regenSize === 0) return 0;
    return ERROR(E_dstBuffer_null);
  }
  dstBuf.fill(b, dst, dst + regenSize);
  return regenSize;
}

/** ZSTD_decompressFrame: the size decoded, or an error; FRAME_IP is where the input stopped. */
let FRAME_IP = 0;

function decompressFrame(dctx, dstBuf, dst, dstCapacity, buf, src, srcSize) {
  let ip = src;
  const ostart = dst;
  const oend = dstCapacity !== 0 ? dst + dstCapacity : dst;
  let op = ostart;
  let remainingSrcSize = srcSize;
  if (remainingSrcSize < ZSTD_FRAMEHEADERSIZE_MIN + ZSTD_blockHeaderSize) return ERROR(E_srcSize_wrong);
  {
    const fhs = frameHeaderSize(buf, ip, ZSTD_FRAMEHEADERSIZE_PREFIX);
    if (isError(fhs)) return fhs;
    if (remainingSrcSize < fhs + ZSTD_blockHeaderSize) return ERROR(E_srcSize_wrong);
    const r = decodeFrameHeader(dctx, buf, ip, fhs);
    if (isError(r)) return r;
    ip += fhs;
    remainingSrcSize -= fhs;
  }
  if (dctx.maxBlockSizeParam !== 0) dctx.fParams.blockSizeMax = Math.min(dctx.fParams.blockSizeMax, dctx.maxBlockSizeParam);
  for (;;) {
    const oBlockEnd = oend;
    let decodedSize;
    const cBlockSize = getcBlockSize(buf, ip, remainingSrcSize);
    if (isError(cBlockSize)) return cBlockSize;
    const lastBlock = BP_LAST;
    const blockType = BP_TYPE;
    const origSize = BP_ORIGSIZE;
    ip += ZSTD_blockHeaderSize;
    remainingSrcSize -= ZSTD_blockHeaderSize;
    if (cBlockSize > remainingSrcSize) return ERROR(E_srcSize_wrong);
    // In-place decompression (ip in [op, oBlockEnd)) can't happen: input and
    // output are different buffers here.
    switch (blockType) {
      case bt_compressed:
        decodedSize = decompressBlockInternal(dctx, dstBuf, op, oBlockEnd - op, buf, ip, cBlockSize, false);
        break;
      case bt_raw:
        decodedSize = copyRawBlock(dstBuf, op, oend - op, buf, ip, cBlockSize);
        break;
      case bt_rle:
        decodedSize = setRleBlock(dstBuf, op, oBlockEnd - op, buf[ip], origSize);
        break;
      default:
        return ERROR(E_corruption_detected);
    }
    if (isError(decodedSize)) return decodedSize;
    if (dctx.validateChecksum) dctx.xxhState.update(dstBuf, op, decodedSize);
    if (decodedSize) op += decodedSize;
    ip += cBlockSize;
    remainingSrcSize -= cBlockSize;
    if (lastBlock) break;
  }
  if (dctx.fParams.frameContentSize !== CONTENTSIZE_UNKNOWN) {
    if (op - ostart !== dctx.fParams.frameContentSize) return ERROR(E_corruption_detected);
  }
  if (dctx.fParams.checksumFlag) {
    if (remainingSrcSize < 4) return ERROR(E_checksum_wrong);
    if (!dctx.forceIgnoreChecksum) {
      const checkCalc = dctx.xxhState.digest32();
      const checkRead = readLE32(buf, ip);
      if (checkRead !== checkCalc) return ERROR(E_checksum_wrong);
    }
    ip += 4;
    remainingSrcSize -= 4;
  }
  FRAME_IP = ip;
  return op - ostart;
}

/** ZSTD_decompressMultiFrame (with a DDict or none) */
function decompressMultiFrame(dctx, dstBuf, dst, dstCapacity, buf, src, srcSize, ddict) {
  const dststart = dst;
  let moreThan1Frame = 0;
  while (srcSize >= ZSTD_FRAMEHEADERSIZE_PREFIX) {
    if (srcSize >= 4) {
      const magicNumber = readLE32(buf, src);
      if ((magicNumber & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 === ZSTD_MAGIC_SKIPPABLE_START) {
        const skippableSize = readSkippableFrameSize(buf, src, srcSize);
        if (isError(skippableSize)) return skippableSize;
        src += skippableSize;
        srcSize -= skippableSize;
        continue;
      }
    }
    if (ddict) decompressBeginUsingDDict(dctx, ddict);
    else decompressBegin(dctx);
    checkContinuity(dctx, dstBuf, dst, dstCapacity);
    {
      const res = decompressFrame(dctx, dstBuf, dst, dstCapacity, buf, src, srcSize);
      if (getErrorCode(res) === E_prefix_unknown && moreThan1Frame === 1) return ERROR(E_srcSize_wrong);
      if (isError(res)) return res;
      srcSize -= FRAME_IP - src;
      src = FRAME_IP;
      if (res !== 0) dst += res;
      dstCapacity -= res;
    }
    moreThan1Frame = 1;
  }
  if (srcSize) return ERROR(E_srcSize_wrong);
  return dst - dststart;
}

/** ZSTD_nextSrcSizeToDecompressWithInputSize */
function nextSrcSizeWithInputSize(dctx, inputSize) {
  if (!(dctx.stage === ZSTDds_decompressBlock || dctx.stage === ZSTDds_decompressLastBlock)) return dctx.expected;
  if (dctx.bType !== bt_raw) return dctx.expected;
  return Math.max(1, Math.min(inputSize, dctx.expected));
}

/** ZSTD_nextInputType: 2 is ZSTDnit_block. */
function nextInputTypeIsBlock(dctx) {
  return dctx.stage === ZSTDds_decompressBlock;
}

/** ZSTD_decompressContinue */
function decompressContinue(dctx, dstBuf, dst, dstCapacity, buf, src, srcSize) {
  if (srcSize !== nextSrcSizeWithInputSize(dctx, srcSize)) return ERROR(E_srcSize_wrong);
  checkContinuity(dctx, dstBuf, dst, dstCapacity);
  dctx.processedCSize += srcSize;
  switch (dctx.stage) {
    case ZSTDds_getFrameHeaderSize:
      if ((readLE32(buf, src) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 === ZSTD_MAGIC_SKIPPABLE_START) {
        dctx.headerBuffer.set(buf.subarray(src, src + srcSize), 0);
        dctx.expected = ZSTD_SKIPPABLEHEADERSIZE - srcSize;
        dctx.stage = ZSTDds_decodeSkippableHeader;
        return 0;
      }
      dctx.headerSize = frameHeaderSize(buf, src, srcSize);
      if (isError(dctx.headerSize)) return dctx.headerSize;
      dctx.headerBuffer.set(buf.subarray(src, src + srcSize), 0);
      dctx.expected = dctx.headerSize - srcSize;
      dctx.stage = ZSTDds_decodeFrameHeader;
      return 0;
    case ZSTDds_decodeFrameHeader: {
      dctx.headerBuffer.set(buf.subarray(src, src + srcSize), dctx.headerSize - srcSize);
      const r = decodeFrameHeader(dctx, dctx.headerBuffer, 0, dctx.headerSize);
      if (isError(r)) return r;
      dctx.expected = ZSTD_blockHeaderSize;
      dctx.stage = ZSTDds_decodeBlockHeader;
      return 0;
    }
    case ZSTDds_decodeBlockHeader: {
      const cBlockSize = getcBlockSize(buf, src, ZSTD_blockHeaderSize);
      if (isError(cBlockSize)) return cBlockSize;
      if (cBlockSize > dctx.fParams.blockSizeMax) return ERROR(E_corruption_detected);
      dctx.expected = cBlockSize;
      dctx.bType = BP_TYPE;
      dctx.rleSize = BP_ORIGSIZE;
      if (cBlockSize) {
        dctx.stage = BP_LAST ? ZSTDds_decompressLastBlock : ZSTDds_decompressBlock;
        return 0;
      }
      if (BP_LAST) {
        if (dctx.fParams.checksumFlag) {
          dctx.expected = 4;
          dctx.stage = ZSTDds_checkChecksum;
        } else {
          dctx.expected = 0;
          dctx.stage = ZSTDds_getFrameHeaderSize;
        }
      } else {
        dctx.expected = ZSTD_blockHeaderSize;
        dctx.stage = ZSTDds_decodeBlockHeader;
      }
      return 0;
    }
    case ZSTDds_decompressLastBlock:
    case ZSTDds_decompressBlock: {
      let rSize;
      switch (dctx.bType) {
        case bt_compressed:
          rSize = decompressBlockInternal(dctx, dstBuf, dst, dstCapacity, buf, src, srcSize, true);
          dctx.expected = 0;
          break;
        case bt_raw:
          rSize = copyRawBlock(dstBuf, dst, dstCapacity, buf, src, srcSize);
          if (isError(rSize)) return rSize;
          dctx.expected -= rSize;
          break;
        case bt_rle:
          rSize = setRleBlock(dstBuf, dst, dstCapacity, buf[src], dctx.rleSize);
          dctx.expected = 0;
          break;
        default:
          return ERROR(E_corruption_detected);
      }
      if (isError(rSize)) return rSize;
      if (rSize > dctx.fParams.blockSizeMax) return ERROR(E_corruption_detected);
      dctx.decodedSize += rSize;
      if (dctx.validateChecksum) dctx.xxhState.update(dstBuf, dst, rSize);
      dctx.prevBuf = dstBuf;
      dctx.previousDstEnd = dst + rSize;
      if (dctx.expected > 0) return rSize;
      if (dctx.stage === ZSTDds_decompressLastBlock) {
        if (dctx.fParams.frameContentSize !== CONTENTSIZE_UNKNOWN && dctx.decodedSize !== dctx.fParams.frameContentSize) {
          return ERROR(E_corruption_detected);
        }
        if (dctx.fParams.checksumFlag) {
          dctx.expected = 4;
          dctx.stage = ZSTDds_checkChecksum;
        } else {
          dctx.expected = 0;
          dctx.stage = ZSTDds_getFrameHeaderSize;
        }
      } else {
        dctx.stage = ZSTDds_decodeBlockHeader;
        dctx.expected = ZSTD_blockHeaderSize;
      }
      return rSize;
    }
    case ZSTDds_checkChecksum:
      if (dctx.validateChecksum) {
        const h32 = dctx.xxhState.digest32();
        const check32 = readLE32(buf, src);
        if (check32 !== h32) return ERROR(E_checksum_wrong);
      }
      dctx.expected = 0;
      dctx.stage = ZSTDds_getFrameHeaderSize;
      return 0;
    case ZSTDds_decodeSkippableHeader:
      dctx.headerBuffer.set(buf.subarray(src, src + srcSize), ZSTD_SKIPPABLEHEADERSIZE - srcSize);
      dctx.expected = readLE32(dctx.headerBuffer, ZSTD_FRAMEIDSIZE);
      dctx.stage = ZSTDds_skipFrame;
      return 0;
    case ZSTDds_skipFrame:
      dctx.expected = 0;
      dctx.stage = ZSTDds_getFrameHeaderSize;
      return 0;
    default:
      return ERROR(E_GENERIC);
  }
}

/** ZSTD_decodingBufferSize_internal */
function decodingBufferSize(windowSize, frameContentSize, bsMax) {
  const blockSize = Math.min(Math.min(windowSize, ZSTD_BLOCKSIZE_MAX), bsMax);
  const neededRBSize = windowSize + blockSize * 2 + WILDCOPY_OVERLENGTH * 2;
  const fcs = frameContentSize === CONTENTSIZE_UNKNOWN ? Infinity : frameContentSize;
  const neededSize = Math.min(fcs, neededRBSize);
  if (neededSize >= 2 ** 64) return ERROR(E_frameParameter_windowTooLarge);
  return neededSize;
}

/** ZSTD_decompressContinueStream (buffered output) */
function decompressContinueStream(zds, buf, src, srcSize) {
  const isSkipFrame = zds.stage === ZSTDds_skipFrame;
  const dstSize = isSkipFrame ? 0 : zds.outBuffSize - zds.outStart;
  const decodedSize = decompressContinue(zds, zds.outBuff, zds.outStart, dstSize, buf, src, srcSize);
  if (isError(decodedSize)) return decodedSize;
  if (!decodedSize && !isSkipFrame) {
    zds.streamStage = zdss_read;
  } else {
    zds.outEnd = zds.outStart + decodedSize;
    zds.streamStage = zdss_flush;
  }
  return 0;
}

/**
 * ZSTD_decompressStream: decodes input[inPos, inSize) into output[outPos,
 * outSize). Returns the C function's result (an error is negative) and sets
 * zds.inPos_ and zds.outPos_.
 */
export function decompressStream(zds, output, outPos, outSize, input, inPos, inSize) {
  const istart = inPos;
  const iend = inSize;
  let ip = istart;
  const dstBuf = output;
  const ostart = outPos;
  const oend = outSize;
  let op = ostart;
  let someMoreWork = 1;
  const done = (ret) => {
    zds.inPos_ = ip;
    zds.outPos_ = op;
    return ret;
  };
  if (inPos > inSize) return done(ERROR(E_srcSize_wrong));
  if (outPos > outSize) return done(ERROR(E_dstSize_tooSmall));
  while (someMoreWork) {
    switch (zds.streamStage) {
      case zdss_init:
        zds.streamStage = zdss_loadHeader;
        zds.lhSize = zds.inPos = zds.outStart = zds.outEnd = 0;
        zds.hostageByte = 0;
      // fall through
      case zdss_loadHeader: {
        const hSize = getFrameHeader(zds.fParams, zds.headerBuffer, 0, zds.lhSize);
        if (isError(hSize)) return done(hSize);
        if (hSize !== 0) {
          const toLoad = hSize - zds.lhSize;
          const remainingInput = iend - ip;
          if (toLoad > remainingInput) {
            if (remainingInput > 0) {
              zds.headerBuffer.set(input.subarray(ip, ip + remainingInput), zds.lhSize);
              zds.lhSize += remainingInput;
            }
            ip = inSize;
            {
              const r = getFrameHeader(zds.fParams, zds.headerBuffer, 0, zds.lhSize);
              if (isError(r)) return done(r);
            }
            return done(Math.max(ZSTD_FRAMEHEADERSIZE_MIN, hSize) - zds.lhSize + ZSTD_blockHeaderSize);
          }
          zds.headerBuffer.set(input.subarray(ip, ip + toLoad), zds.lhSize);
          zds.lhSize = hSize;
          ip += toLoad;
          break;
        }
        // check for single-pass mode opportunity
        if (zds.fParams.frameContentSize !== CONTENTSIZE_UNKNOWN && zds.fParams.frameType !== 1 && oend - op >= zds.fParams.frameContentSize) {
          const cSize = findFrameCompressedSize(input, istart, iend - istart);
          if (cSize <= iend - istart) {
            // (an error is negative, so it is <= too, as (size_t) it isn't)
            if (!isError(cSize)) {
              const decompressedSize = decompressMultiFrame(zds, dstBuf, op, oend - op, input, istart, cSize, getDDict(zds));
              if (isError(decompressedSize)) return done(decompressedSize);
              ip = istart + cSize;
              op += decompressedSize;
              zds.expected = 0;
              zds.streamStage = zdss_init;
              someMoreWork = 0;
              break;
            }
          }
        }
        // Consume header (see ZSTDds_decodeFrameHeader)
        decompressBeginUsingDDict(zds, getDDict(zds));
        if ((readLE32(zds.headerBuffer, 0) & ZSTD_MAGIC_SKIPPABLE_MASK) >>> 0 === ZSTD_MAGIC_SKIPPABLE_START) {
          zds.expected = readLE32(zds.headerBuffer, ZSTD_FRAMEIDSIZE);
          zds.stage = ZSTDds_skipFrame;
        } else {
          const r = decodeFrameHeader(zds, zds.headerBuffer, 0, zds.lhSize);
          if (isError(r)) return done(r);
          zds.expected = ZSTD_blockHeaderSize;
          zds.stage = ZSTDds_decodeBlockHeader;
        }
        zds.fParams.windowSize = Math.max(zds.fParams.windowSize, 1 << ZSTD_WINDOWLOG_ABSOLUTEMIN);
        if (zds.fParams.windowSize > zds.maxWindowSize) return done(ERROR(E_frameParameter_windowTooLarge));
        if (zds.maxBlockSizeParam !== 0) zds.fParams.blockSizeMax = Math.min(zds.fParams.blockSizeMax, zds.maxBlockSizeParam);
        {
          const neededInBuffSize = Math.max(zds.fParams.blockSizeMax, 4);
          const neededOutBuffSize = decodingBufferSize(zds.fParams.windowSize, zds.fParams.frameContentSize, zds.fParams.blockSizeMax);
          if (isError(neededOutBuffSize)) return done(neededOutBuffSize);
          // ZSTD_DCtx_updateOversizedDuration
          if (zds.inBuffSize + zds.outBuffSize >= (neededInBuffSize + neededOutBuffSize) * ZSTD_WORKSPACETOOLARGE_FACTOR) {
            zds.oversizedDuration++;
          } else {
            zds.oversizedDuration = 0;
          }
          const tooSmall = zds.inBuffSize < neededInBuffSize || zds.outBuffSize < neededOutBuffSize;
          const tooLarge = zds.oversizedDuration >= ZSTD_WORKSPACETOOLARGE_MAXDURATION;
          if (tooSmall || tooLarge) {
            zds.inBuffSize = 0;
            zds.outBuffSize = 0;
            try {
              zds.inBuff = new Uint8Array(neededInBuffSize);
              zds.outBuff = new Uint8Array(neededOutBuffSize);
            } catch {
              zds.inBuff = null;
              return done(ERROR(E_memory_allocation));
            }
            zds.inBuffSize = neededInBuffSize;
            zds.outBuffSize = neededOutBuffSize;
          }
        }
        zds.streamStage = zdss_read;
      }
      // fall through
      case zdss_read: {
        const neededInSize = nextSrcSizeWithInputSize(zds, iend - ip);
        if (neededInSize === 0) {
          zds.streamStage = zdss_init;
          someMoreWork = 0;
          break;
        }
        if (iend - ip >= neededInSize) {
          const r = decompressContinueStream(zds, input, ip, neededInSize);
          if (isError(r)) return done(r);
          ip += neededInSize;
          break;
        }
        if (ip === iend) {
          someMoreWork = 0;
          break;
        }
        zds.streamStage = zdss_load;
      }
      // fall through
      case zdss_load: {
        const neededInSize = zds.expected;
        const toLoad = neededInSize - zds.inPos;
        const isSkipFrame = zds.stage === ZSTDds_skipFrame;
        let loadedSize;
        if (isSkipFrame) {
          loadedSize = Math.min(toLoad, iend - ip);
        } else {
          if (toLoad > zds.inBuffSize - zds.inPos) return done(ERROR(E_corruption_detected));
          loadedSize = Math.min(toLoad, iend - ip);
          if (loadedSize > 0) zds.inBuff.set(input.subarray(ip, ip + loadedSize), zds.inPos);
        }
        if (loadedSize !== 0) {
          ip += loadedSize;
          zds.inPos += loadedSize;
        }
        if (loadedSize < toLoad) {
          someMoreWork = 0;
          break;
        }
        zds.inPos = 0;
        const r = decompressContinueStream(zds, zds.inBuff, 0, neededInSize);
        if (isError(r)) return done(r);
        break;
      }
      case zdss_flush: {
        const toFlushSize = zds.outEnd - zds.outStart;
        const flushedSize = Math.min(oend - op, toFlushSize);
        if (flushedSize > 0) dstBuf.set(zds.outBuff.subarray(zds.outStart, zds.outStart + flushedSize), op);
        op += flushedSize;
        zds.outStart += flushedSize;
        if (flushedSize === toFlushSize) {
          zds.streamStage = zdss_read;
          const fcs = zds.fParams.frameContentSize === CONTENTSIZE_UNKNOWN ? Infinity : zds.fParams.frameContentSize;
          if (zds.outBuffSize < fcs && zds.outStart + zds.fParams.blockSizeMax > zds.outBuffSize) {
            zds.outStart = zds.outEnd = 0;
          }
          break;
        }
        someMoreWork = 0;
        break;
      }
      default:
        return done(ERROR(E_GENERIC));
    }
  }
  if (ip === istart && op === ostart) {
    zds.noForwardProgress++;
    if (zds.noForwardProgress >= ZSTD_NO_FORWARD_PROGRESS_MAX) {
      if (op === oend) return done(ERROR(E_noForwardProgress_destFull));
      if (ip === iend) return done(ERROR(E_noForwardProgress_inputEmpty));
    }
  } else {
    zds.noForwardProgress = 0;
  }
  {
    let nextSrcSizeHint = zds.expected;
    if (!nextSrcSizeHint) {
      if (zds.outEnd === zds.outStart) {
        if (zds.hostageByte) {
          if (ip >= inSize) {
            zds.streamStage = zdss_read;
            return done(1);
          }
          ip++;
        }
        return done(0);
      }
      if (!zds.hostageByte) {
        ip--;
        zds.hostageByte = 1;
      }
      return done(1);
    }
    nextSrcSizeHint += ZSTD_blockHeaderSize * (nextInputTypeIsBlock(zds) ? 1 : 0);
    nextSrcSizeHint -= zds.inPos;
    return done(nextSrcSizeHint);
  }
}
