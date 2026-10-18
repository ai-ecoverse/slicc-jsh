/**
 * Brotli decoder: a port of Google's reference decoder (google/brotli c/dec
 * and the parts of c/common it uses, MIT; LICENSE next to this file) to
 * JavaScript. It follows the C code as Node 22.22.0 links it (deps/brotli,
 * brotli 1.1.0; 1.2.0's decoder differs only in a fast path), state machine
 * for state machine, so a stream decodes as in Node: the same output for each
 * call, the same input consumed, and the same error at the same point.
 *
 * brotli_reg_t is 32 bits here (the C code's 32-bit build): the accumulator
 * fits a JavaScript int. Pointers are offsets into typed arrays. Only what
 * Node uses is ported: no compound or custom dictionaries, no metadata
 * callbacks, no BrotliDecoderTakeOutput.
 *
 * The static dictionary (122,784 bytes) is decoded on first use from
 * dictionary.bin.br, Google's own Brotli encoding of it that references no
 * dictionary words, by this decoder.
 */
import DICTIONARY_BR from './dictionary.bin.br';

/* BrotliDecoderResult */
export const RESULT_ERROR = 0;
export const RESULT_SUCCESS = 1;
export const RESULT_NEEDS_MORE_INPUT = 2;
export const RESULT_NEEDS_MORE_OUTPUT = 3;

/* BrotliDecoderErrorCode */
const NO_ERROR = 0;
const SUCCESS = 1;
const NEEDS_MORE_INPUT = 2;
const NEEDS_MORE_OUTPUT = 3;
const ERROR_FORMAT_EXUBERANT_NIBBLE = -1;
const ERROR_FORMAT_RESERVED = -2;
const ERROR_FORMAT_EXUBERANT_META_NIBBLE = -3;
const ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET = -4;
const ERROR_FORMAT_SIMPLE_HUFFMAN_SAME = -5;
const ERROR_FORMAT_CL_SPACE = -6;
const ERROR_FORMAT_HUFFMAN_SPACE = -7;
const ERROR_FORMAT_CONTEXT_MAP_REPEAT = -8;
const ERROR_FORMAT_BLOCK_LENGTH_1 = -9;
const ERROR_FORMAT_BLOCK_LENGTH_2 = -10;
const ERROR_FORMAT_TRANSFORM = -11;
const ERROR_FORMAT_DICTIONARY = -12;
const ERROR_FORMAT_WINDOW_BITS = -13;
const ERROR_FORMAT_PADDING_1 = -14;
const ERROR_FORMAT_PADDING_2 = -15;
const ERROR_FORMAT_DISTANCE = -16;
const ERROR_DICTIONARY_NOT_SET = -19;
const ERROR_INVALID_ARGUMENTS = -20;
const ERROR_ALLOC_RING_BUFFER_1 = -26;
const ERROR_ALLOC_RING_BUFFER_2 = -27;
const ERROR_UNREACHABLE = -31;

/** BrotliDecoderErrorString. */
export function errorString(code) {
  switch (code) {
    case 0: return '_NO_ERROR';
    case 1: return '_SUCCESS';
    case 2: return '_NEEDS_MORE_INPUT';
    case 3: return '_NEEDS_MORE_OUTPUT';
    case -1: return '_ERROR_FORMAT_EXUBERANT_NIBBLE';
    case -2: return '_ERROR_FORMAT_RESERVED';
    case -3: return '_ERROR_FORMAT_EXUBERANT_META_NIBBLE';
    case -4: return '_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET';
    case -5: return '_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME';
    case -6: return '_ERROR_FORMAT_CL_SPACE';
    case -7: return '_ERROR_FORMAT_HUFFMAN_SPACE';
    case -8: return '_ERROR_FORMAT_CONTEXT_MAP_REPEAT';
    case -9: return '_ERROR_FORMAT_BLOCK_LENGTH_1';
    case -10: return '_ERROR_FORMAT_BLOCK_LENGTH_2';
    case -11: return '_ERROR_FORMAT_TRANSFORM';
    case -12: return '_ERROR_FORMAT_DICTIONARY';
    case -13: return '_ERROR_FORMAT_WINDOW_BITS';
    case -14: return '_ERROR_FORMAT_PADDING_1';
    case -15: return '_ERROR_FORMAT_PADDING_2';
    case -16: return '_ERROR_FORMAT_DISTANCE';
    case -18: return '_ERROR_COMPOUND_DICTIONARY';
    case -19: return '_ERROR_DICTIONARY_NOT_SET';
    case -20: return '_ERROR_INVALID_ARGUMENTS';
    case -21: return '_ERROR_ALLOC_CONTEXT_MODES';
    case -22: return '_ERROR_ALLOC_TREE_GROUPS';
    case -25: return '_ERROR_ALLOC_CONTEXT_MAP';
    case -26: return '_ERROR_ALLOC_RING_BUFFER_1';
    case -27: return '_ERROR_ALLOC_RING_BUFFER_2';
    case -30: return '_ERROR_ALLOC_BLOCK_TYPE_TREES';
    case -31: return '_ERROR_UNREACHABLE';
    default: return 'INVALID';
  }
}

/* BrotliDecoderParameter */
const PARAM_DISABLE_RING_BUFFER_REALLOCATION = 0;
const PARAM_LARGE_WINDOW = 1;

/* constants.h */
const NUM_LITERAL_SYMBOLS = 256;
const NUM_COMMAND_SYMBOLS = 704;
const NUM_BLOCK_LEN_SYMBOLS = 26;
const REPEAT_PREVIOUS_CODE_LENGTH = 16;
const CODE_LENGTH_CODES = 18;
const INITIAL_REPEATED_CODE_LENGTH = 8;
const LARGE_MAX_DISTANCE_BITS = 62;
const LARGE_MIN_WBITS = 10;
const LARGE_MAX_WBITS = 30;
const NUM_DISTANCE_SHORT_CODES = 16;
const MAX_DISTANCE_BITS = 24;
const MAX_ALLOWED_DISTANCE = 0x7ffffffc;
const LITERAL_CONTEXT_BITS = 6;
const DISTANCE_CONTEXT_BITS = 2;
const WINDOW_GAP = 16;
const BLOCK_SIZE_CAP = 1 << 24;
const MIN_DICTIONARY_WORD_LENGTH = 4;
const MAX_DICTIONARY_WORD_LENGTH = 31;
const distanceAlphabetSize = (npostfix, ndirect, maxnbits) =>
  NUM_DISTANCE_SHORT_CODES + ndirect + maxnbits * (2 << npostfix);

/* huffman.h */
const HUFFMAN_MAX_CODE_LENGTH = 15;
const HUFFMAN_MAX_SIZE_26 = 396;
const HUFFMAN_MAX_SIZE_258 = 632;
const HUFFMAN_MAX_SIZE_272 = 646;
const HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH = 5;
const HUFFMAN_TABLE_BITS = 8;
const HUFFMAN_TABLE_MASK = 0xff;
/* A HuffmanCode is (value << 16) | bits. */
const hc = (bits, value) => ((value & 0xffff) << 16) | bits;

/* bit_reader.h */
const FAST_INPUT_SLACK = 28;
const kBitMask = new Int32Array(33);
for (let i = 1; i <= 32; i++) kBitMask[i] = i === 32 ? -1 : (1 << i) - 1;

/* decode.c */
const kRingBufferWriteAheadSlack = 542;
const kCodeLengthCodeOrder = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const kCodeLengthPrefixLength = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4];
const kCodeLengthPrefixValue = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5];

/* constants.c: _kBrotliPrefixCodeRanges, as offset and nbits. */
const kBlockLengthOffset = [
  1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265, 2289, 4337, 8433,
  16625,
];
const kBlockLengthNBits = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24];

/* prefix.c: kCmdLut, built as BrotliDecoderInitCmdLut builds it. */
const CMD_INSERT_EXTRA = new Uint8Array(NUM_COMMAND_SYMBOLS);
const CMD_COPY_EXTRA = new Uint8Array(NUM_COMMAND_SYMBOLS);
const CMD_DISTANCE_CODE = new Int8Array(NUM_COMMAND_SYMBOLS);
const CMD_CONTEXT = new Uint8Array(NUM_COMMAND_SYMBOLS);
const CMD_INSERT_OFFSET = new Uint16Array(NUM_COMMAND_SYMBOLS);
const CMD_COPY_OFFSET = new Uint16Array(NUM_COMMAND_SYMBOLS);
{
  const insertExtra = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24];
  const copyExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24];
  const cellPos = [0, 1, 0, 1, 8, 9, 2, 16, 10, 17, 18];
  const insertOffsets = [0];
  const copyOffsets = [2];
  for (let i = 0; i < 23; ++i) {
    insertOffsets[i + 1] = (insertOffsets[i] + (1 << insertExtra[i])) & 0xffff;
    copyOffsets[i + 1] = (copyOffsets[i] + (1 << copyExtra[i])) & 0xffff;
  }
  for (let symbol = 0; symbol < NUM_COMMAND_SYMBOLS; ++symbol) {
    const cellIdx = symbol >> 6;
    const pos = cellPos[cellIdx];
    const copyCode = ((pos << 3) & 0x18) + (symbol & 7);
    const copyOffset = copyOffsets[copyCode];
    const insertCode = (pos & 0x18) + ((symbol >> 3) & 7);
    CMD_COPY_EXTRA[symbol] = copyExtra[copyCode];
    CMD_CONTEXT[symbol] = copyOffset > 4 ? 3 : copyOffset - 2;
    CMD_COPY_OFFSET[symbol] = copyOffset;
    CMD_DISTANCE_CODE[symbol] = cellIdx >= 2 ? -1 : 0;
    CMD_INSERT_EXTRA[symbol] = insertExtra[insertCode];
    CMD_INSERT_OFFSET[symbol] = insertOffsets[insertCode];
  }
}

/*
 * context.c: _kBrotliContextLookupTable (CONTEXT_LSB6, CONTEXT_MSB6,
 * CONTEXT_UTF8, CONTEXT_SIGNED; last byte, then second last byte), unpacked
 * as Google's Java/JS decoder unpacks it.
 */
const CONTEXT_LUT = new Uint8Array(2048);
{
  const utfMap =
    '         !!  !                  "#$##%#$&\'##(#)#++++++++++((&*\'##,---,---,-----,-----,-----&#\'###.///.///./////./////./////&#\'# ';
  const utfRle = 'A/*  \':  & : $  \x81 @';
  for (let i = 0; i < 256; ++i) {
    CONTEXT_LUT[i] = i & 0x3f;
    CONTEXT_LUT[512 + i] = i >> 2;
    CONTEXT_LUT[1792 + i] = 2 + (i >> 6);
  }
  for (let i = 0; i < 128; ++i) CONTEXT_LUT[1024 + i] = 4 * (utfMap.charCodeAt(i) - 32);
  for (let i = 0; i < 64; ++i) {
    CONTEXT_LUT[1152 + i] = i & 1;
    CONTEXT_LUT[1216 + i] = 2 + (i & 1);
  }
  let offset = 1280;
  for (let k = 0; k < 19; ++k) {
    const rep = utfRle.charCodeAt(k) - 32;
    for (let i = 0; i < rep; ++i) CONTEXT_LUT[offset++] = k & 3;
  }
  for (let i = 0; i < 16; ++i) {
    CONTEXT_LUT[1792 + i] = 1;
    CONTEXT_LUT[2032 + i] = 6;
  }
  CONTEXT_LUT[1792] = 0;
  CONTEXT_LUT[2047] = 7;
  for (let i = 0; i < 256; ++i) CONTEXT_LUT[1536 + i] = CONTEXT_LUT[1792 + i] << 3;
}

/* transform.c: the RFC 7932 transforms. */
const TRANSFORM_OMIT_LAST_9 = 9;
const TRANSFORM_UPPERCASE_FIRST = 10;
const TRANSFORM_UPPERCASE_ALL = 11;
const TRANSFORM_OMIT_FIRST_1 = 12;
const TRANSFORM_OMIT_FIRST_9 = 20;
const kPrefixSuffix = Uint8Array.from(
  '\x01 \x02, \x08 of the \x04 of \x02s \x01.\x05 and \x04 ' +
    'in \x01"\x04 to \x02">\x01\n\x02. \x01]\x05 for \x03 a \x06 ' +
    "that \x01'\x06 with \x06 from \x04 by \x01(\x06. T" +
    'he \x04 on \x04 as \x04 is \x04ing \x02\n\t\x01:\x03ed ' +
    '\x02="\x04 at \x03ly \x01,\x02=\'\x05.com/\x07. This \x05' +
    ' not \x03er \x03al \x04ful \x04ive \x05less \x04es' +
    't \x04ize \x02\xc2\xa0\x04ous \x05 the \x02e \x00',
  (c) => c.charCodeAt(0)
);
const kPrefixSuffixMap = [
  0x00, 0x02, 0x05, 0x0e, 0x13, 0x16, 0x18, 0x1e, 0x23, 0x25, 0x2a, 0x2d, 0x2f, 0x32, 0x34, 0x3a, 0x3e, 0x45, 0x47,
  0x4e, 0x55, 0x5a, 0x5c, 0x63, 0x68, 0x6d, 0x72, 0x77, 0x7a, 0x7c, 0x80, 0x83, 0x88, 0x8c, 0x8e, 0x91, 0x97, 0x9f,
  0xa5, 0xa9, 0xad, 0xb2, 0xb7, 0xbd, 0xc2, 0xc7, 0xca, 0xcf, 0xd5, 0xd8,
];
// [prefix_id, transform, suffix_id] triplets.
const kTransformsData = [
  49, 0, 49, 49, 0, 0, 0, 0, 0, 49, 12, 49, 49, 10, 0, 49, 0, 47, 0, 0, 49, 4, 0, 0, 49, 0, 3, 49, 10, 49, 49, 0, 6,
  49, 13, 49, 49, 1, 49, 1, 0, 0, 49, 0, 1, 0, 10, 0, 49, 0, 7, 49, 0, 9, 48, 0, 0, 49, 0, 8, 49, 0, 5, 49, 0, 10,
  49, 0, 11, 49, 3, 49, 49, 0, 13, 49, 0, 14, 49, 14, 49, 49, 2, 49, 49, 0, 15, 49, 0, 16, 0, 10, 49, 49, 0, 12, 5,
  0, 49, 0, 0, 1, 49, 15, 49, 49, 0, 18, 49, 0, 17, 49, 0, 19, 49, 0, 20, 49, 16, 49, 49, 17, 49, 47, 0, 49, 49, 4,
  49, 49, 0, 22, 49, 11, 49, 49, 0, 23, 49, 0, 24, 49, 0, 25, 49, 7, 49, 49, 1, 26, 49, 0, 27, 49, 0, 28, 0, 0, 12,
  49, 0, 29, 49, 20, 49, 49, 18, 49, 49, 6, 49, 49, 0, 21, 49, 10, 1, 49, 8, 49, 49, 0, 31, 49, 0, 32, 47, 0, 3, 49,
  5, 49, 49, 9, 49, 0, 10, 1, 49, 10, 8, 5, 0, 21, 49, 11, 0, 49, 10, 10, 49, 0, 30, 0, 0, 5, 35, 0, 49, 47, 0, 2,
  49, 10, 17, 49, 0, 36, 49, 0, 33, 5, 0, 0, 49, 10, 21, 49, 10, 5, 49, 0, 37, 0, 0, 30, 49, 0, 38, 0, 11, 0, 49, 0,
  39, 0, 11, 49, 49, 0, 34, 49, 11, 8, 49, 10, 12, 0, 0, 21, 49, 0, 40, 0, 10, 12, 49, 0, 41, 49, 0, 42, 49, 11, 17,
  49, 0, 43, 0, 10, 5, 49, 11, 10, 0, 0, 34, 49, 10, 33, 49, 0, 44, 49, 11, 5, 45, 0, 49, 0, 0, 33, 49, 10, 30, 49,
  11, 30, 49, 0, 46, 49, 11, 1, 49, 10, 34, 0, 10, 33, 0, 11, 30, 0, 11, 1, 49, 11, 33, 49, 11, 21, 49, 11, 12, 0,
  11, 5, 49, 11, 34, 0, 11, 12, 0, 10, 30, 0, 11, 34, 0, 10, 34,
];
const NUM_TRANSFORMS = 121;
const CUT_OFF_TRANSFORM_0 = 0;

function toUpperCase(p, i) {
  if (p[i] < 0xc0) {
    if (p[i] >= 0x61 && p[i] <= 0x7a) p[i] ^= 32;
    return 1;
  }
  // An overly simplified uppercasing model for UTF-8.
  if (p[i] < 0xe0) {
    p[i + 1] ^= 32;
    return 2;
  }
  // An arbitrary transform for three byte characters.
  p[i + 2] ^= 5;
  return 3;
}

/** BrotliTransformDictionaryWord, for the RFC transforms (no shifts). */
function transformDictionaryWord(dst, dstOff, word, wordOff, len, transformIdx) {
  let idx = dstOff;
  let prefix = kPrefixSuffixMap[kTransformsData[transformIdx * 3]];
  const type = kTransformsData[transformIdx * 3 + 1];
  let suffix = kPrefixSuffixMap[kTransformsData[transformIdx * 3 + 2]];
  for (let n = kPrefixSuffix[prefix++]; n > 0; n--) dst[idx++] = kPrefixSuffix[prefix++];
  if (type <= TRANSFORM_OMIT_LAST_9) {
    len -= type;
  } else if (type >= TRANSFORM_OMIT_FIRST_1 && type <= TRANSFORM_OMIT_FIRST_9) {
    const skip = type - (TRANSFORM_OMIT_FIRST_1 - 1);
    wordOff += skip;
    len -= skip;
  }
  for (let i = 0; i < len; i++) dst[idx++] = word[wordOff + i];
  if (type === TRANSFORM_UPPERCASE_FIRST) {
    toUpperCase(dst, idx - len);
  } else if (type === TRANSFORM_UPPERCASE_ALL) {
    let at = idx - len;
    while (len > 0) {
      const step = toUpperCase(dst, at);
      at += step;
      len -= step;
    }
  }
  for (let n = kPrefixSuffix[suffix++]; n > 0; n--) dst[idx++] = kPrefixSuffix[suffix++];
  return idx - dstOff;
}

/* dictionary.c: the RFC 7932 static dictionary. */
const kSizeBitsByLength = new Uint8Array(32);
const kOffsetsByLength = new Uint32Array(32);
{
  const bits = [0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5];
  let offset = 0;
  for (let i = 0; i < 32; i++) {
    kSizeBitsByLength[i] = bits[i] ?? 0;
    kOffsetsByLength[i] = offset;
    if (kSizeBitsByLength[i]) offset += i << kSizeBitsByLength[i];
  }
}
let dictionaryData = null;
let dictionaryLoading = false;

/** The dictionary's words, decoded on first use; null while it is decoded. */
function dictionary() {
  if (dictionaryData || dictionaryLoading) return dictionaryData;
  dictionaryLoading = true;
  try {
    const s = new State();
    const out = new Uint8Array(122784);
    s.decompressStream(DICTIONARY_BR, 0, DICTIONARY_BR.length, out, 0, out.length);
    if (s.result !== RESULT_SUCCESS || s.availOut !== 0) throw new Error('brotli: the static dictionary is corrupt');
    dictionaryData = out;
  } finally {
    dictionaryLoading = false;
  }
  return dictionaryData;
}

/* huffman.c */
const kReverseBits = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 0x80 >> b;
  kReverseBits[i] = r;
}
const REVERSE_BITS_LOWEST = 1 << 7;

/** Stores code in table[off], table[off + step], …, below table[off + end]. */
function replicateValue(table, off, step, end, code) {
  do {
    end -= step;
    table[off + end] = code;
  } while (end > 0);
}

function nextTableBitSize(count, len, rootBits) {
  let left = 1 << (len - rootBits);
  while (len < HUFFMAN_MAX_CODE_LENGTH) {
    left -= count[len];
    if (left <= 0) break;
    ++len;
    left <<= 1;
  }
  return len - rootBits;
}

const clSorted = new Int32Array(CODE_LENGTH_CODES);
const clOffset = new Int32Array(HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH + 1);

function buildCodeLengthsHuffmanTable(table, codeLengths, count) {
  let symbol = -1;
  let bits = 1;
  for (let k = 0; k < 5; k++) {
    symbol += count[bits];
    clOffset[bits] = symbol;
    bits++;
  }
  // Symbols with code length 0 are placed after all other symbols.
  clOffset[0] = CODE_LENGTH_CODES - 1;
  symbol = CODE_LENGTH_CODES;
  do {
    for (let k = 0; k < 6; k++) {
      symbol--;
      clSorted[clOffset[codeLengths[symbol]]--] = symbol;
    }
  } while (symbol !== 0);
  const tableSize = 1 << HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH;
  // Special case: all symbols but one have 0 code length.
  if (clOffset[0] === 0) {
    const code = hc(0, clSorted[0]);
    for (let key = 0; key < tableSize; ++key) table[key] = code;
    return;
  }
  let key = 0;
  let keyStep = REVERSE_BITS_LOWEST;
  symbol = 0;
  bits = 1;
  let step = 2;
  do {
    for (let bitsCount = count[bits]; bitsCount !== 0; --bitsCount) {
      replicateValue(table, kReverseBits[key], step, tableSize, hc(bits, clSorted[symbol++]));
      key += keyStep;
    }
    step <<= 1;
    keyStep >>= 1;
  } while (++bits <= HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH);
}

/** symbolLists[SL + i] is the C code's symbol_lists[i] (i may be negative). */
const SL = HUFFMAN_MAX_CODE_LENGTH + 1;

function buildHuffmanTable(root, rootOff, rootBits, symbolLists, count) {
  let maxLength = -1;
  while (symbolLists[SL + maxLength] === 0xffff) maxLength--;
  maxLength += HUFFMAN_MAX_CODE_LENGTH + 1;
  let table = rootOff;
  let tableBits = rootBits;
  let tableSize = 1 << tableBits;
  let totalSize = tableSize;
  // Fill in the root table. Reduce the table size if possible, and create
  // the repetitions by copying.
  if (tableBits > maxLength) {
    tableBits = maxLength;
    tableSize = 1 << tableBits;
  }
  let key = 0;
  let keyStep = REVERSE_BITS_LOWEST;
  let bits = 1;
  let step = 2;
  let symbol;
  do {
    symbol = bits - (HUFFMAN_MAX_CODE_LENGTH + 1);
    for (let bitsCount = count[bits]; bitsCount !== 0; --bitsCount) {
      symbol = symbolLists[SL + symbol];
      replicateValue(root, table + kReverseBits[key], step, tableSize, hc(bits, symbol));
      key += keyStep;
    }
    step <<= 1;
    keyStep >>= 1;
  } while (++bits <= tableBits);
  // If rootBits != tableBits then replicate to fill the remaining slots.
  while (totalSize !== tableSize) {
    root.copyWithin(table + tableSize, table, table + tableSize);
    tableSize <<= 1;
  }
  // Fill in 2nd level tables and add pointers to the root table.
  keyStep = REVERSE_BITS_LOWEST >> (rootBits - 1);
  let subKey = REVERSE_BITS_LOWEST << 1;
  let subKeyStep = REVERSE_BITS_LOWEST;
  step = 2;
  for (let len = rootBits + 1; len <= maxLength; ++len) {
    symbol = len - (HUFFMAN_MAX_CODE_LENGTH + 1);
    for (; count[len] !== 0; --count[len]) {
      if (subKey === REVERSE_BITS_LOWEST << 1) {
        table += tableSize;
        tableBits = nextTableBitSize(count, len, rootBits);
        tableSize = 1 << tableBits;
        totalSize += tableSize;
        subKey = kReverseBits[key];
        key += keyStep;
        root[rootOff + subKey] = hc(tableBits + rootBits, table - rootOff - subKey);
        subKey = 0;
      }
      symbol = symbolLists[SL + symbol];
      replicateValue(root, table + kReverseBits[subKey], step, tableSize, hc(len - rootBits, symbol));
      subKey += subKeyStep;
    }
    step <<= 1;
    subKeyStep >>= 1;
  }
  return totalSize;
}

function buildSimpleHuffmanTable(table, off, rootBits, val, numSymbols) {
  let tableSize = 1;
  const goalSize = 1 << rootBits;
  switch (numSymbols) {
    case 0:
      table[off] = hc(0, val[0]);
      break;
    case 1:
      if (val[1] > val[0]) {
        table[off] = hc(1, val[0]);
        table[off + 1] = hc(1, val[1]);
      } else {
        table[off] = hc(1, val[1]);
        table[off + 1] = hc(1, val[0]);
      }
      tableSize = 2;
      break;
    case 2:
      table[off] = hc(1, val[0]);
      table[off + 2] = hc(1, val[0]);
      if (val[2] > val[1]) {
        table[off + 1] = hc(2, val[1]);
        table[off + 3] = hc(2, val[2]);
      } else {
        table[off + 1] = hc(2, val[2]);
        table[off + 3] = hc(2, val[1]);
      }
      tableSize = 4;
      break;
    case 3: {
      for (let i = 0; i < 3; ++i) {
        for (let k = i + 1; k < 4; ++k) {
          if (val[k] < val[i]) {
            const t = val[k];
            val[k] = val[i];
            val[i] = t;
          }
        }
      }
      table[off] = hc(2, val[0]);
      table[off + 2] = hc(2, val[1]);
      table[off + 1] = hc(2, val[2]);
      table[off + 3] = hc(2, val[3]);
      tableSize = 4;
      break;
    }
    case 4: {
      if (val[3] < val[2]) {
        const t = val[3];
        val[3] = val[2];
        val[2] = t;
      }
      table[off] = hc(1, val[0]);
      table[off + 1] = hc(2, val[1]);
      table[off + 2] = hc(1, val[0]);
      table[off + 3] = hc(3, val[2]);
      table[off + 4] = hc(1, val[0]);
      table[off + 5] = hc(2, val[1]);
      table[off + 6] = hc(1, val[0]);
      table[off + 7] = hc(3, val[3]);
      tableSize = 8;
      break;
    }
  }
  while (tableSize !== goalSize) {
    table.copyWithin(off + tableSize, off, off + tableSize);
    tableSize <<= 1;
  }
  return goalSize;
}

/* state.h: BrotliRunningState and the substates. */
const STATE_UNINITED = 0;
const STATE_LARGE_WINDOW_BITS = 1;
const STATE_INITIALIZE = 2;
const STATE_METABLOCK_BEGIN = 3;
const STATE_METABLOCK_HEADER = 4;
const STATE_METABLOCK_HEADER_2 = 5;
const STATE_CONTEXT_MODES = 6;
const STATE_COMMAND_BEGIN = 7;
const STATE_COMMAND_INNER = 8;
const STATE_COMMAND_POST_DECODE_LITERALS = 9;
const STATE_COMMAND_POST_WRAP_COPY = 10;
const STATE_UNCOMPRESSED = 11;
const STATE_METADATA = 12;
const STATE_COMMAND_INNER_WRITE = 13;
const STATE_METABLOCK_DONE = 14;
const STATE_COMMAND_POST_WRITE_1 = 15;
const STATE_COMMAND_POST_WRITE_2 = 16;
const STATE_BEFORE_COMPRESSED_METABLOCK_HEADER = 17;
const STATE_HUFFMAN_CODE_0 = 18;
const STATE_HUFFMAN_CODE_1 = 19;
const STATE_HUFFMAN_CODE_2 = 20;
const STATE_HUFFMAN_CODE_3 = 21;
const STATE_CONTEXT_MAP_1 = 22;
const STATE_CONTEXT_MAP_2 = 23;
const STATE_TREE_GROUP = 24;
const STATE_BEFORE_COMPRESSED_METABLOCK_BODY = 25;
const STATE_DONE = 26;

const HEADER_NONE = 0;
const HEADER_EMPTY = 1;
const HEADER_NIBBLES = 2;
const HEADER_SIZE = 3;
const HEADER_UNCOMPRESSED = 4;
const HEADER_RESERVED = 5;
const HEADER_BYTES = 6;
const HEADER_METADATA = 7;

const UNCOMPRESSED_NONE = 0;
const UNCOMPRESSED_WRITE = 1;

const TREE_GROUP_NONE = 0;
const TREE_GROUP_LOOP = 1;

const CONTEXT_MAP_NONE = 0;
const CONTEXT_MAP_READ_PREFIX = 1;
const CONTEXT_MAP_HUFFMAN = 2;
const CONTEXT_MAP_DECODE = 3;
const CONTEXT_MAP_TRANSFORM = 4;

const HUFFMAN_NONE = 0;
const HUFFMAN_SIMPLE_SIZE = 1;
const HUFFMAN_SIMPLE_READ = 2;
const HUFFMAN_SIMPLE_BUILD = 3;
const HUFFMAN_COMPLEX = 4;
const HUFFMAN_LENGTH_SYMBOLS = 5;

const UINT8_NONE = 0;
const UINT8_SHORT = 1;
const UINT8_LONG = 2;

const BLOCK_LENGTH_NONE = 0;
const BLOCK_LENGTH_SUFFIX = 1;

/** HuffmanTreeGroup: the trees' tables in `codes`, each tree's offset in `htrees`. */
class TreeGroup {
  constructor(alphabetSizeMax, alphabetSizeLimit, ntrees) {
    this.alphabetSizeMax = alphabetSizeMax;
    this.alphabetSizeLimit = alphabetSizeLimit;
    this.numHtrees = ntrees;
    this.htrees = new Int32Array(ntrees);
    // 376 = 256 (1st level table) + 4 + 7 + 15 + 31 + 63 (2nd level mix-tables)
    this.codes = new Int32Array(ntrees * (alphabetSizeLimit + 376));
  }
}

/* The bit reader. `val` holds bitPos bits (an int: bit 31 reads negative). */

function setInput(s, buf, next, avail) {
  s.inBuf = buf;
  s.nextIn = next;
  s.lastIn = next + avail;
  s.guardIn = avail + 1 > FAST_INPUT_SLACK ? next + (avail + 1 - FAST_INPUT_SLACK) : next;
}

/** BrotliFillBitWindow (the 32-bit build): at least 17 bits. */
function fillBitWindow(s) {
  if (s.bitPos <= 16) {
    const buf = s.inBuf;
    const p = s.nextIn;
    s.val |= (buf[p] | (buf[p + 1] << 8)) << s.bitPos;
    s.bitPos += 16;
    s.nextIn = p + 2;
  }
}

function pullByte(s) {
  if (s.nextIn === s.lastIn) return false;
  s.val |= s.inBuf[s.nextIn++] << s.bitPos;
  s.bitPos += 8;
  return true;
}

function dropBits(s, n) {
  s.bitPos -= n;
  s.val >>>= n;
}

function takeBits(s, n) {
  const v = s.val & kBitMask[n];
  dropBits(s, n);
  return v;
}

/** BrotliSafeGetBits: the bits, or -1 if the input has too few. */
function safeGetBits(s, n) {
  while (s.bitPos < n) if (!pullByte(s)) return -1;
  return s.val & kBitMask[n];
}

/** BrotliSafeReadBits (n <= 24): the bits, or -1 if the input has too few. */
function safeReadBits(s, n) {
  while (s.bitPos < n) if (!pullByte(s)) return -1;
  return takeBits(s, n);
}

/** BrotliSafeReadBits32: the bits (unsigned), or -1. */
function safeReadBits32(s, n) {
  if (n <= 24) return safeReadBits(s, n);
  const val = s.val;
  const bitPos = s.bitPos;
  const nextIn = s.nextIn;
  const low = safeReadBits(s, 16);
  const high = low < 0 ? -1 : safeReadBits(s, n - 16);
  if (high < 0) {
    s.val = val;
    s.bitPos = bitPos;
    s.nextIn = nextIn;
    return -1;
  }
  return (low | (high << 16)) >>> 0;
}

function readBits24(s, n) {
  if (n <= 16) {
    fillBitWindow(s);
    return takeBits(s, n);
  }
  fillBitWindow(s);
  const low = takeBits(s, 16);
  fillBitWindow(s);
  return low | (takeBits(s, n - 16) << 16);
}

function readBits32(s, n) {
  if (n <= 16) {
    fillBitWindow(s);
    return takeBits(s, n);
  }
  fillBitWindow(s);
  const low = takeBits(s, 16);
  fillBitWindow(s);
  return (low | (takeBits(s, n - 16) << 16)) >>> 0;
}

function bitReaderNormalize(s) {
  if (s.bitPos < 32) s.val &= kBitMask[s.bitPos];
}

function bitReaderUnload(s) {
  const unusedBytes = s.bitPos >> 3;
  s.nextIn -= unusedBytes;
  s.bitPos -= unusedBytes << 3;
  bitReaderNormalize(s);
}

function jumpToByteBoundary(s) {
  const padBitsCount = s.bitPos & 7;
  let padBits = 0;
  if (padBitsCount !== 0) padBits = takeBits(s, padBitsCount);
  bitReaderNormalize(s);
  return padBits === 0;
}

/** BrotliGetRemainingBytes. */
function remainingBytes(s) {
  const availIn = s.lastIn - s.nextIn;
  if (availIn > 1 << LARGE_MAX_WBITS) return 1 << LARGE_MAX_WBITS;
  return availIn + (s.bitPos >> 3);
}

/** BrotliCopyBytes. */
function copyBytes(dest, destOff, s, num) {
  while (s.bitPos >= 8 && num > 0) {
    if (dest) dest[destOff++] = s.val & 0xff;
    dropBits(s, 8);
    --num;
  }
  bitReaderNormalize(s);
  if (num > 0) {
    if (dest) dest.set(s.inBuf.subarray(s.nextIn, s.nextIn + num), destOff);
    s.nextIn += num;
  }
}

/** BrotliWarmupBitReader (unaligned reads are fast: no alignment). */
function warmupBitReader(s) {
  if (s.bitPos === 0) {
    s.val = 0;
    if (!pullByte(s)) return false;
  }
  return true;
}

const checkInputAmount = (s) => s.nextIn < s.guardIn;

/* Huffman symbols. A table is an Int32Array and an offset into it. */

/** DecodeSymbol: `bits` has at least 15 valid bits. */
function decodeSymbol(bits, table, off, s) {
  off += bits & HUFFMAN_TABLE_MASK;
  let code = table[off];
  if ((code & 0xff) > HUFFMAN_TABLE_BITS) {
    const nbits = (code & 0xff) - HUFFMAN_TABLE_BITS;
    dropBits(s, HUFFMAN_TABLE_BITS);
    off += (code >>> 16) + ((bits >>> HUFFMAN_TABLE_BITS) & kBitMask[nbits]);
    code = table[off];
  }
  dropBits(s, code & 0xff);
  return code >>> 16;
}

function readSymbol(table, off, s) {
  fillBitWindow(s);
  return decodeSymbol(s.val, table, off, s);
}

/** SafeDecodeSymbol: the symbol, or -1. */
function safeDecodeSymbol(table, off, s) {
  let availableBits = s.bitPos;
  if (availableBits === 0) {
    if ((table[off] & 0xff) === 0) return table[off] >>> 16;
    return -1;
  }
  let val = s.val;
  off += val & HUFFMAN_TABLE_MASK;
  let code = table[off];
  if ((code & 0xff) <= HUFFMAN_TABLE_BITS) {
    if ((code & 0xff) <= availableBits) {
      dropBits(s, code & 0xff);
      return code >>> 16;
    }
    return -1;
  }
  if (availableBits <= HUFFMAN_TABLE_BITS) return -1;
  // Speculatively drop HUFFMAN_TABLE_BITS.
  val = (val & kBitMask[code & 0xff]) >>> HUFFMAN_TABLE_BITS;
  availableBits -= HUFFMAN_TABLE_BITS;
  off += (code >>> 16) + val;
  code = table[off];
  if (availableBits < (code & 0xff)) return -1;
  dropBits(s, HUFFMAN_TABLE_BITS + (code & 0xff));
  return code >>> 16;
}

/** SafeReadSymbol: the symbol, or -1. */
function safeReadSymbol(table, off, s) {
  const val = safeGetBits(s, 15);
  if (val >= 0) return decodeSymbol(val, table, off, s);
  return safeDecodeSymbol(table, off, s);
}

function log2Floor(x) {
  let result = 0;
  while (x) {
    x >>>= 1;
    ++result;
  }
  return result;
}

/* BrotliDecoderState and the decoder's functions, as methods. */
class State {
  constructor() {
    this.state = STATE_UNINITED;
    this.loopCounter = 0;
    // BrotliBitReader.
    this.val = 0;
    this.bitPos = 0;
    this.inBuf = null;
    this.nextIn = 0;
    this.lastIn = 0;
    this.guardIn = 0;
    // Temporary storage for remaining input.
    this.buffer = new Uint8Array(8);
    this.bufferLength = 0;
    this.pos = 0;
    this.maxBackwardDistance = 0;
    this.maxDistance = 0;
    this.ringbufferSize = 0;
    this.ringbufferMask = 0;
    this.distRbIdx = 0;
    this.distRb = [16, 15, 11, 4];
    this.errorCode = NO_ERROR;
    this.metaBlockRemainingLen = 0;
    this.ringbuffer = null;
    this.ringbufferEnd = 0;
    this.htreeCommand = 0;
    this.contextLookup = 0;
    this.contextMapSlice = 0;
    this.distContextMapSlice = 0;
    this.literalHgroup = null;
    this.insertCopyHgroup = null;
    this.distanceHgroup = null;
    // block_type_trees, then block_len_trees at BLOCK_LEN_TREES.
    this.blockTrees = null;
    this.trivialLiteralContext = 0;
    this.distanceContext = 0;
    this.blockLength = [0, 0, 0];
    this.blockLengthIndex = 0;
    this.numBlockTypes = [0, 0, 0];
    this.blockTypeRb = [0, 0, 0, 0, 0, 0];
    this.distancePostfixBits = 0;
    this.numDirectDistanceCodes = 0;
    // num_literal_htrees, num_dist_htrees.
    this.numHtrees = [0, 0];
    this.distContextMap = null;
    this.literalHtree = 0;
    this.rbRoundtrips = 0;
    this.partialPosOut = 0;
    this.mtfUpperBound = 63;
    this.mtf = new Uint8Array(4 * (64 + 1));
    this.copyLength = 0;
    this.distanceCode = 0;
    this.distHtreeIndex = 0;
    this.substateMetablockHeader = HEADER_NONE;
    this.substateUncompressed = UNCOMPRESSED_NONE;
    this.substateDecodeUint8 = UINT8_NONE;
    this.substateReadBlockLength = BLOCK_LENGTH_NONE;
    this.newRingbufferSize = 0;
    this.isLastMetablock = 0;
    this.isUncompressed = 0;
    this.isMetadata = 0;
    this.shouldWrapRingbuffer = 0;
    this.cannyRingbufferAllocation = 1;
    this.largeWindow = 0;
    this.windowBits = 0;
    this.sizeNibbles = 0;
    this.contextMap = null;
    this.contextModes = null;
    this.trivialLiteralContexts = new Int32Array(8);
    // BrotliMetablockHeaderArena.
    this.hSubstateTreeGroup = TREE_GROUP_NONE;
    this.hSubstateContextMap = CONTEXT_MAP_NONE;
    this.hSubstateHuffman = HUFFMAN_NONE;
    this.hSubLoopCounter = 0;
    this.hRepeatCodeLen = 0;
    this.hPrevCodeLen = 0;
    this.hSymbol = 0;
    this.hRepeat = 0;
    this.hSpace = 0;
    this.hTable = new Int32Array(32);
    this.hSymbolLists = new Uint16Array(HUFFMAN_MAX_CODE_LENGTH + 1 + NUM_COMMAND_SYMBOLS);
    this.hNextSymbol = new Int32Array(32);
    this.hCodeLengthCodeLengths = new Uint8Array(CODE_LENGTH_CODES);
    this.hCodeLengthHisto = new Uint16Array(16);
    this.hHtreeIndex = 0;
    this.hNext = 0;
    this.hContextIndex = 0;
    this.hMaxRunLengthPrefix = 0;
    this.hCode = 0;
    this.hContextMapTable = new Int32Array(HUFFMAN_MAX_SIZE_272);
    this.tableSize = 0;
    // BrotliMetablockBodyArena.
    this.distExtraBits = new Uint8Array(544);
    this.distOffset = new Uint32Array(544);
    // DecompressStream's arguments and results.
    this.out = null;
    this.nextOut = 0;
    this.availOut = 0;
    this.hasOut = false;
    this.result = RESULT_SUCCESS;
    this.availIn = 0;
  }

  /** BrotliDecoderSetParameter. */
  setParameter(p, value) {
    if (this.state !== STATE_UNINITED) return false;
    switch (p) {
      case PARAM_DISABLE_RING_BUFFER_REALLOCATION:
        this.cannyRingbufferAllocation = value ? 0 : 1;
        return true;
      case PARAM_LARGE_WINDOW:
        this.largeWindow = value ? 1 : 0;
        return true;
      default:
        return false;
    }
  }

  /**
   * BrotliDecoderDecompressStream: decodes input[inOff, inOff + inLen) into
   * output[outOff, outOff + outLen). Sets `result` (a BrotliDecoderResult),
   * `availIn` and `availOut`; `errorCode` is BrotliDecoderGetErrorCode.
   */
  decompressStream(input, inOff, inLen, output, outOff, outLen) {
    this.out = output;
    this.nextOut = outOff;
    this.availOut = outLen;
    this.availIn = inLen;
    this.result = decompressStream(this, input, inOff);
    this.out = null;
    return this.result;
  }
}

function saveErrorCode(s, e) {
  s.errorCode = e;
  if (s.bufferLength !== 0 && s.nextIn === s.lastIn) {
    // If internal buffer is depleted at last, reset it.
    s.bufferLength = 0;
  }
  switch (e) {
    case SUCCESS:
      return RESULT_SUCCESS;
    case NEEDS_MORE_INPUT:
      return RESULT_NEEDS_MORE_INPUT;
    case NEEDS_MORE_OUTPUT:
      return RESULT_NEEDS_MORE_OUTPUT;
    default:
      return RESULT_ERROR;
  }
}

/** Decodes WBITS by reading 1 - 7 bits, or 0x11 for "Large Window Brotli". */
function decodeWindowBits(s) {
  const largeWindow = s.largeWindow;
  s.largeWindow = 0;
  let n = takeBits(s, 1);
  if (n === 0) {
    s.windowBits = 16;
    return SUCCESS;
  }
  n = takeBits(s, 3);
  if (n !== 0) {
    s.windowBits = (17 + n) & 63;
    return SUCCESS;
  }
  n = takeBits(s, 3);
  if (n === 1) {
    if (largeWindow) {
      n = takeBits(s, 1);
      if (n === 1) return ERROR_FORMAT_WINDOW_BITS;
      s.largeWindow = 1;
      return SUCCESS;
    }
    return ERROR_FORMAT_WINDOW_BITS;
  }
  if (n !== 0) {
    s.windowBits = (8 + n) & 63;
    return SUCCESS;
  }
  s.windowBits = 17;
  return SUCCESS;
}

/** Decodes a number in [0..255] into arr[idx], reading 1 - 11 bits. */
function decodeVarLenUint8(s, arr, idx) {
  let bits;
  switch (s.substateDecodeUint8) {
    case UINT8_NONE:
      bits = safeReadBits(s, 1);
      if (bits < 0) return NEEDS_MORE_INPUT;
      if (bits === 0) {
        arr[idx] = 0;
        return SUCCESS;
      }
    // Fall through.
    case UINT8_SHORT:
      bits = safeReadBits(s, 3);
      if (bits < 0) {
        s.substateDecodeUint8 = UINT8_SHORT;
        return NEEDS_MORE_INPUT;
      }
      if (bits === 0) {
        arr[idx] = 1;
        s.substateDecodeUint8 = UINT8_NONE;
        return SUCCESS;
      }
      // Use the output value as temporary storage. It MUST be persisted.
      arr[idx] = bits;
    // Fall through.
    case UINT8_LONG:
      bits = safeReadBits(s, arr[idx]);
      if (bits < 0) {
        s.substateDecodeUint8 = UINT8_LONG;
        return NEEDS_MORE_INPUT;
      }
      arr[idx] = (1 << arr[idx]) + bits;
      s.substateDecodeUint8 = UINT8_NONE;
      return SUCCESS;
    default:
      return ERROR_UNREACHABLE;
  }
}

/** Decodes a metablock length and flags by reading 2 - 31 bits. */
function decodeMetaBlockLength(s) {
  let bits;
  for (;;) {
    switch (s.substateMetablockHeader) {
      case HEADER_NONE:
        bits = safeReadBits(s, 1);
        if (bits < 0) return NEEDS_MORE_INPUT;
        s.isLastMetablock = bits ? 1 : 0;
        s.metaBlockRemainingLen = 0;
        s.isUncompressed = 0;
        s.isMetadata = 0;
        if (!s.isLastMetablock) {
          s.substateMetablockHeader = HEADER_NIBBLES;
          break;
        }
        s.substateMetablockHeader = HEADER_EMPTY;
      // Fall through.
      case HEADER_EMPTY:
        bits = safeReadBits(s, 1);
        if (bits < 0) return NEEDS_MORE_INPUT;
        if (bits) {
          s.substateMetablockHeader = HEADER_NONE;
          return SUCCESS;
        }
        s.substateMetablockHeader = HEADER_NIBBLES;
      // Fall through.
      case HEADER_NIBBLES:
        bits = safeReadBits(s, 2);
        if (bits < 0) return NEEDS_MORE_INPUT;
        s.sizeNibbles = bits + 4;
        s.loopCounter = 0;
        if (bits === 3) {
          s.isMetadata = 1;
          s.substateMetablockHeader = HEADER_RESERVED;
          break;
        }
        s.substateMetablockHeader = HEADER_SIZE;
      // Fall through.
      case HEADER_SIZE: {
        let i = s.loopCounter;
        for (; i < s.sizeNibbles; ++i) {
          bits = safeReadBits(s, 4);
          if (bits < 0) {
            s.loopCounter = i;
            return NEEDS_MORE_INPUT;
          }
          if (i + 1 === s.sizeNibbles && s.sizeNibbles > 4 && bits === 0) return ERROR_FORMAT_EXUBERANT_NIBBLE;
          s.metaBlockRemainingLen |= bits << (i * 4);
        }
        s.substateMetablockHeader = HEADER_UNCOMPRESSED;
      }
      // Fall through.
      case HEADER_UNCOMPRESSED:
        if (!s.isLastMetablock) {
          bits = safeReadBits(s, 1);
          if (bits < 0) return NEEDS_MORE_INPUT;
          s.isUncompressed = bits ? 1 : 0;
        }
        ++s.metaBlockRemainingLen;
        s.substateMetablockHeader = HEADER_NONE;
        return SUCCESS;
      case HEADER_RESERVED:
        bits = safeReadBits(s, 1);
        if (bits < 0) return NEEDS_MORE_INPUT;
        if (bits !== 0) return ERROR_FORMAT_RESERVED;
        s.substateMetablockHeader = HEADER_BYTES;
      // Fall through.
      case HEADER_BYTES:
        bits = safeReadBits(s, 2);
        if (bits < 0) return NEEDS_MORE_INPUT;
        if (bits === 0) {
          s.substateMetablockHeader = HEADER_NONE;
          return SUCCESS;
        }
        s.sizeNibbles = bits;
        s.substateMetablockHeader = HEADER_METADATA;
      // Fall through.
      case HEADER_METADATA: {
        let i = s.loopCounter;
        for (; i < s.sizeNibbles; ++i) {
          bits = safeReadBits(s, 8);
          if (bits < 0) {
            s.loopCounter = i;
            return NEEDS_MORE_INPUT;
          }
          if (i + 1 === s.sizeNibbles && s.sizeNibbles > 1 && bits === 0) {
            return ERROR_FORMAT_EXUBERANT_META_NIBBLE;
          }
          s.metaBlockRemainingLen |= bits << (i * 8);
        }
        ++s.metaBlockRemainingLen;
        s.substateMetablockHeader = HEADER_NONE;
        return SUCCESS;
      }
      default:
        return ERROR_UNREACHABLE;
    }
  }
}

/** Reads (s.hSymbol + 1) symbols, 1..11 bits each, with no duplicates. */
function readSimpleHuffmanSymbols(alphabetSizeMax, alphabetSizeLimit, s) {
  const maxBits = log2Floor(alphabetSizeMax - 1);
  let i = s.hSubLoopCounter;
  const numSymbols = s.hSymbol;
  while (i <= numSymbols) {
    const v = safeReadBits(s, maxBits);
    if (v < 0) {
      s.hSubLoopCounter = i;
      s.hSubstateHuffman = HUFFMAN_SIMPLE_READ;
      return NEEDS_MORE_INPUT;
    }
    if (v >= alphabetSizeLimit) return ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET;
    s.hSymbolLists[i] = v;
    ++i;
  }
  for (i = 0; i < numSymbols; ++i) {
    for (let k = i + 1; k <= numSymbols; ++k) {
      if (s.hSymbolLists[i] === s.hSymbolLists[k]) return ERROR_FORMAT_SIMPLE_HUFFMAN_SAME;
    }
  }
  return SUCCESS;
}

/** ProcessSingleCodeLength. */
function processSingleCodeLength(s, codeLen) {
  s.hRepeat = 0;
  if (codeLen !== 0) {
    // code_len == 1..15
    s.hSymbolLists[SL + s.hNextSymbol[codeLen]] = s.hSymbol;
    s.hNextSymbol[codeLen] = s.hSymbol;
    s.hPrevCodeLen = codeLen;
    s.hSpace = (s.hSpace - (32768 >>> codeLen)) >>> 0;
    s.hCodeLengthHisto[codeLen]++;
  }
  s.hSymbol++;
}

/** ProcessRepeatedCodeLength. */
function processRepeatedCodeLength(s, codeLen, repeatDelta, alphabetSize) {
  let extraBits = 3;
  let newLen = 0;
  if (codeLen === REPEAT_PREVIOUS_CODE_LENGTH) {
    newLen = s.hPrevCodeLen;
    extraBits = 2;
  }
  if (s.hRepeatCodeLen !== newLen) {
    s.hRepeat = 0;
    s.hRepeatCodeLen = newLen;
  }
  const oldRepeat = s.hRepeat;
  if (s.hRepeat > 0) {
    s.hRepeat -= 2;
    s.hRepeat <<= extraBits;
  }
  s.hRepeat += repeatDelta + 3;
  repeatDelta = s.hRepeat - oldRepeat;
  if (s.hSymbol + repeatDelta > alphabetSize) {
    s.hSymbol = alphabetSize;
    s.hSpace = 0xfffff;
    return;
  }
  if (s.hRepeatCodeLen !== 0) {
    const last = s.hSymbol + repeatDelta;
    let next = s.hNextSymbol[s.hRepeatCodeLen];
    do {
      s.hSymbolLists[SL + next] = s.hSymbol;
      next = s.hSymbol;
    } while (++s.hSymbol !== last);
    s.hNextSymbol[s.hRepeatCodeLen] = next;
    s.hSpace = (s.hSpace - repeatDelta * (1 << (15 - s.hRepeatCodeLen))) >>> 0;
    s.hCodeLengthHisto[s.hRepeatCodeLen] += repeatDelta;
  } else {
    s.hSymbol += repeatDelta;
  }
}

/** ReadSymbolCodeLengths: the fast path, while the input lasts. */
function readSymbolCodeLengths(alphabetSize, s) {
  if (!warmupBitReader(s)) return NEEDS_MORE_INPUT;
  while (s.hSymbol < alphabetSize && s.hSpace > 0) {
    if (!checkInputAmount(s)) return NEEDS_MORE_INPUT;
    fillBitWindow(s);
    const p = s.hTable[s.val & kBitMask[HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH]];
    dropBits(s, p & 0xff); // Use 1..5 bits.
    const codeLen = p >>> 16; // code_len == 0..17
    if (codeLen < REPEAT_PREVIOUS_CODE_LENGTH) {
      processSingleCodeLength(s, codeLen);
    } else {
      // code_len == 16..17, extra_bits == 2..3
      const extraBits = codeLen === REPEAT_PREVIOUS_CODE_LENGTH ? 2 : 3;
      const repeatDelta = s.val & kBitMask[extraBits];
      dropBits(s, extraBits);
      processRepeatedCodeLength(s, codeLen, repeatDelta, alphabetSize);
    }
  }
  return SUCCESS;
}

function safeReadSymbolCodeLengths(alphabetSize, s) {
  let getByte = false;
  while (s.hSymbol < alphabetSize && s.hSpace > 0) {
    if (getByte && !pullByte(s)) return NEEDS_MORE_INPUT;
    getByte = false;
    const availableBits = s.bitPos;
    let bits = 0;
    if (availableBits !== 0) bits = s.val;
    const p = s.hTable[bits & kBitMask[HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH]];
    const pBits = p & 0xff;
    if (pBits > availableBits) {
      getByte = true;
      continue;
    }
    const codeLen = p >>> 16; // code_len == 0..17
    if (codeLen < REPEAT_PREVIOUS_CODE_LENGTH) {
      dropBits(s, pBits);
      processSingleCodeLength(s, codeLen);
    } else {
      // code_len == 16..17, extra_bits == 2..3
      const extraBits = codeLen - 14;
      const repeatDelta = (bits >>> pBits) & kBitMask[extraBits];
      if (availableBits < pBits + extraBits) {
        getByte = true;
        continue;
      }
      dropBits(s, pBits + extraBits);
      processRepeatedCodeLength(s, codeLen, repeatDelta, alphabetSize);
    }
  }
  return SUCCESS;
}

/** Reads and decodes 15..18 codes using a static prefix code (2..4 bits each). */
function readCodeLengthCodeLengths(s) {
  let numCodes = s.hRepeat;
  let space = s.hSpace;
  let i = s.hSubLoopCounter;
  for (; i < CODE_LENGTH_CODES; ++i) {
    const codeLenIdx = kCodeLengthCodeOrder[i];
    let ix = safeGetBits(s, 4);
    if (ix < 0) {
      const availableBits = s.bitPos;
      ix = availableBits !== 0 ? s.val & 0xf : 0;
      if (kCodeLengthPrefixLength[ix] > availableBits) {
        s.hSubLoopCounter = i;
        s.hRepeat = numCodes;
        s.hSpace = space;
        s.hSubstateHuffman = HUFFMAN_COMPLEX;
        return NEEDS_MORE_INPUT;
      }
    }
    const v = kCodeLengthPrefixValue[ix];
    dropBits(s, kCodeLengthPrefixLength[ix]);
    s.hCodeLengthCodeLengths[codeLenIdx] = v;
    if (v !== 0) {
      space = (space - (32 >>> v)) >>> 0;
      ++numCodes;
      ++s.hCodeLengthHisto[v];
      if (((space - 1) >>> 0) >= 32) {
        // space is 0 or wrapped around.
        break;
      }
    }
  }
  if (!(numCodes === 1 || space === 0)) return ERROR_FORMAT_CL_SPACE;
  return SUCCESS;
}

/**
 * Decodes a Huffman table into table[off...]. Its size, for a caller that
 * wants it, is s.tableSize.
 */
function readHuffmanCode(alphabetSizeMax, alphabetSizeLimit, table, off, s) {
  for (;;) {
    switch (s.hSubstateHuffman) {
      case HUFFMAN_NONE: {
        const v = safeReadBits(s, 2);
        if (v < 0) return NEEDS_MORE_INPUT;
        s.hSubLoopCounter = v;
        // 1 for simple code; 0 for no skipping, 2 skips 2 code lengths,
        // 3 skips 3 code lengths.
        if (s.hSubLoopCounter !== 1) {
          s.hSpace = 32;
          s.hRepeat = 0; // num_codes
          s.hCodeLengthHisto.fill(0, 0, HUFFMAN_MAX_CODE_LENGTH_CODE_LENGTH + 1);
          s.hCodeLengthCodeLengths.fill(0);
          s.hSubstateHuffman = HUFFMAN_COMPLEX;
          continue;
        }
      }
      // Fall through.
      case HUFFMAN_SIMPLE_SIZE: {
        // Read symbols, codes & code lengths directly.
        const v = safeReadBits(s, 2);
        if (v < 0) {
          s.hSubstateHuffman = HUFFMAN_SIMPLE_SIZE;
          return NEEDS_MORE_INPUT;
        }
        s.hSymbol = v; // num_symbols
        s.hSubLoopCounter = 0;
      }
      // Fall through.
      case HUFFMAN_SIMPLE_READ: {
        const result = readSimpleHuffmanSymbols(alphabetSizeMax, alphabetSizeLimit, s);
        if (result !== SUCCESS) return result;
      }
      // Fall through.
      case HUFFMAN_SIMPLE_BUILD: {
        if (s.hSymbol === 3) {
          const bits = safeReadBits(s, 1);
          if (bits < 0) {
            s.hSubstateHuffman = HUFFMAN_SIMPLE_BUILD;
            return NEEDS_MORE_INPUT;
          }
          s.hSymbol += bits;
        }
        s.tableSize = buildSimpleHuffmanTable(table, off, HUFFMAN_TABLE_BITS, s.hSymbolLists, s.hSymbol);
        s.hSubstateHuffman = HUFFMAN_NONE;
        return SUCCESS;
      }
      // Decode Huffman-coded code lengths.
      case HUFFMAN_COMPLEX: {
        const result = readCodeLengthCodeLengths(s);
        if (result !== SUCCESS) return result;
        buildCodeLengthsHuffmanTable(s.hTable, s.hCodeLengthCodeLengths, s.hCodeLengthHisto);
        s.hCodeLengthHisto.fill(0);
        for (let i = 0; i <= HUFFMAN_MAX_CODE_LENGTH; ++i) {
          s.hNextSymbol[i] = i - (HUFFMAN_MAX_CODE_LENGTH + 1);
          s.hSymbolLists[SL + s.hNextSymbol[i]] = 0xffff;
        }
        s.hSymbol = 0;
        s.hPrevCodeLen = INITIAL_REPEATED_CODE_LENGTH;
        s.hRepeat = 0;
        s.hRepeatCodeLen = 0;
        s.hSpace = 32768;
        s.hSubstateHuffman = HUFFMAN_LENGTH_SYMBOLS;
      }
      // Fall through.
      case HUFFMAN_LENGTH_SYMBOLS: {
        let result = readSymbolCodeLengths(alphabetSizeLimit, s);
        if (result === NEEDS_MORE_INPUT) result = safeReadSymbolCodeLengths(alphabetSizeLimit, s);
        if (result !== SUCCESS) return result;
        if (s.hSpace !== 0) return ERROR_FORMAT_HUFFMAN_SPACE;
        s.tableSize = buildHuffmanTable(table, off, HUFFMAN_TABLE_BITS, s.hSymbolLists, s.hCodeLengthHisto);
        s.hSubstateHuffman = HUFFMAN_NONE;
        return SUCCESS;
      }
      default:
        return ERROR_UNREACHABLE;
    }
  }
}

/** Decodes a block length by reading 3..39 bits. */
function readBlockLength(table, off, s) {
  const code = readSymbol(table, off, s);
  return kBlockLengthOffset[code] + readBits24(s, kBlockLengthNBits[code]);
}

/** SafeReadBlockLength: the length, or -1. */
function safeReadBlockLength(s, table, off) {
  let index;
  if (s.substateReadBlockLength === BLOCK_LENGTH_NONE) {
    index = safeReadSymbol(table, off, s);
    if (index < 0) return -1;
  } else {
    index = s.blockLengthIndex;
  }
  const bits = safeReadBits(s, kBlockLengthNBits[index]);
  if (bits < 0) {
    s.blockLengthIndex = index;
    s.substateReadBlockLength = BLOCK_LENGTH_SUFFIX;
    return -1;
  }
  s.substateReadBlockLength = BLOCK_LENGTH_NONE;
  return kBlockLengthOffset[index] + bits;
}

/** InverseMoveToFrontTransform. mtf[1 + i] is the C code's mtf_u8[i]. */
function inverseMoveToFrontTransform(v, vLen, s) {
  const mtf = s.mtf;
  // Reinitialize elements that could have been changed.
  const upper = (s.mtfUpperBound + 1) * 4;
  for (let i = 0; i < upper; i++) mtf[1 + i] = i;
  let upperBound = 0;
  for (let i = 0; i < vLen; ++i) {
    let index = v[i];
    const value = mtf[1 + index];
    upperBound |= v[i];
    v[i] = value;
    mtf[0] = value;
    do {
      index--;
      mtf[1 + index + 1] = mtf[1 + index];
    } while (index >= 0);
  }
  // Remember the amount of elements to be reinitialized.
  s.mtfUpperBound = upperBound >> 2;
}

/** Decodes a series of Huffman tables using readHuffmanCode. */
function huffmanTreeGroupDecode(group, s) {
  if (s.hSubstateTreeGroup !== TREE_GROUP_LOOP) {
    s.hNext = 0;
    s.hHtreeIndex = 0;
    s.hSubstateTreeGroup = TREE_GROUP_LOOP;
  }
  while (s.hHtreeIndex < group.numHtrees) {
    const result = readHuffmanCode(group.alphabetSizeMax, group.alphabetSizeLimit, group.codes, s.hNext, s);
    if (result !== SUCCESS) return result;
    group.htrees[s.hHtreeIndex] = s.hNext;
    s.hNext += s.tableSize;
    ++s.hHtreeIndex;
  }
  s.hSubstateTreeGroup = TREE_GROUP_NONE;
  return SUCCESS;
}

/**
 * Decodes a context map: `which` 0 is the literal one (s.contextMap,
 * s.numHtrees[0]), 1 the distance one (s.distContextMap, s.numHtrees[1]).
 */
function decodeContextMap(contextMapSize, which, s) {
  let result = SUCCESS;
  switch (s.hSubstateContextMap) {
    case CONTEXT_MAP_NONE: {
      result = decodeVarLenUint8(s, s.numHtrees, which);
      if (result !== SUCCESS) return result;
      s.numHtrees[which]++;
      s.hContextIndex = 0;
      const map = new Uint8Array(contextMapSize);
      if (which === 0) s.contextMap = map;
      else s.distContextMap = map;
      if (s.numHtrees[which] <= 1) return SUCCESS;
      s.hSubstateContextMap = CONTEXT_MAP_READ_PREFIX;
    }
    // Fall through.
    case CONTEXT_MAP_READ_PREFIX: {
      // In next stage readHuffmanCode uses at least 4 bits, so it is safe to
      // peek 4 bits ahead.
      const bits = safeGetBits(s, 5);
      if (bits < 0) return NEEDS_MORE_INPUT;
      if ((bits & 1) !== 0) {
        // Use RLE for zeros.
        s.hMaxRunLengthPrefix = (bits >> 1) + 1;
        dropBits(s, 5);
      } else {
        s.hMaxRunLengthPrefix = 0;
        dropBits(s, 1);
      }
      s.hSubstateContextMap = CONTEXT_MAP_HUFFMAN;
    }
    // Fall through.
    case CONTEXT_MAP_HUFFMAN: {
      const alphabetSize = s.numHtrees[which] + s.hMaxRunLengthPrefix;
      result = readHuffmanCode(alphabetSize, alphabetSize, s.hContextMapTable, 0, s);
      if (result !== SUCCESS) return result;
      s.hCode = 0xffff;
      s.hSubstateContextMap = CONTEXT_MAP_DECODE;
    }
    // Fall through.
    case CONTEXT_MAP_DECODE: {
      let contextIndex = s.hContextIndex;
      const maxRunLengthPrefix = s.hMaxRunLengthPrefix;
      const contextMap = which === 0 ? s.contextMap : s.distContextMap;
      let code = s.hCode;
      let skipPreamble = code !== 0xffff;
      while (contextIndex < contextMapSize || skipPreamble) {
        if (!skipPreamble) {
          code = safeReadSymbol(s.hContextMapTable, 0, s);
          if (code < 0) {
            s.hCode = 0xffff;
            s.hContextIndex = contextIndex;
            return NEEDS_MORE_INPUT;
          }
          if (code === 0) {
            contextMap[contextIndex++] = 0;
            continue;
          }
          if (code > maxRunLengthPrefix) {
            contextMap[contextIndex++] = code - maxRunLengthPrefix;
            continue;
          }
        } else {
          skipPreamble = false;
        }
        // RLE sub-stage.
        let reps = safeReadBits(s, code);
        if (reps < 0) {
          s.hCode = code;
          s.hContextIndex = contextIndex;
          return NEEDS_MORE_INPUT;
        }
        reps += 1 << code;
        if (contextIndex + reps > contextMapSize) return ERROR_FORMAT_CONTEXT_MAP_REPEAT;
        do {
          contextMap[contextIndex++] = 0;
        } while (--reps);
      }
    }
    // Fall through.
    case CONTEXT_MAP_TRANSFORM: {
      const bits = safeReadBits(s, 1);
      if (bits < 0) {
        s.hSubstateContextMap = CONTEXT_MAP_TRANSFORM;
        return NEEDS_MORE_INPUT;
      }
      if (bits !== 0) {
        inverseMoveToFrontTransform(which === 0 ? s.contextMap : s.distContextMap, contextMapSize, s);
      }
      s.hSubstateContextMap = CONTEXT_MAP_NONE;
      return SUCCESS;
    }
    default:
      return ERROR_UNREACHABLE;
  }
}

const BLOCK_LEN_TREES = 3 * HUFFMAN_MAX_SIZE_258;

/** Decodes a block type and length and updates the block type ring buffer. */
function decodeBlockTypeAndLength(safe, s, treeType) {
  const maxBlockType = s.numBlockTypes[treeType];
  const trees = s.blockTrees;
  const typeTree = treeType * HUFFMAN_MAX_SIZE_258;
  const lenTree = BLOCK_LEN_TREES + treeType * HUFFMAN_MAX_SIZE_26;
  const rb = treeType * 2;
  let blockType;
  if (maxBlockType <= 1) return false;
  // Read 0..15 + 3..39 bits.
  if (!safe) {
    blockType = readSymbol(trees, typeTree, s);
    s.blockLength[treeType] = readBlockLength(trees, lenTree, s);
  } else {
    const val = s.val;
    const bitPos = s.bitPos;
    const nextIn = s.nextIn;
    blockType = safeReadSymbol(trees, typeTree, s);
    if (blockType < 0) return false;
    const length = safeReadBlockLength(s, trees, lenTree);
    if (length < 0) {
      s.substateReadBlockLength = BLOCK_LENGTH_NONE;
      s.val = val;
      s.bitPos = bitPos;
      s.nextIn = nextIn;
      return false;
    }
    s.blockLength[treeType] = length;
  }
  if (blockType === 1) {
    blockType = s.blockTypeRb[rb + 1] + 1;
  } else if (blockType === 0) {
    blockType = s.blockTypeRb[rb];
  } else {
    blockType -= 2;
  }
  if (blockType >= maxBlockType) blockType -= maxBlockType;
  s.blockTypeRb[rb] = s.blockTypeRb[rb + 1];
  s.blockTypeRb[rb + 1] = blockType;
  return true;
}

function detectTrivialLiteralBlockTypes(s) {
  s.trivialLiteralContexts.fill(0);
  for (let i = 0; i < s.numBlockTypes[0]; i++) {
    const offset = i << LITERAL_CONTEXT_BITS;
    let error = 0;
    const sample = s.contextMap[offset];
    for (let j = 0; j < 1 << LITERAL_CONTEXT_BITS; j++) error |= s.contextMap[offset + j] ^ sample;
    if (error === 0) s.trivialLiteralContexts[i >> 5] |= 1 << (i & 31);
  }
}

function prepareLiteralDecoding(s) {
  const blockType = s.blockTypeRb[1];
  const contextOffset = blockType << LITERAL_CONTEXT_BITS;
  s.contextMapSlice = contextOffset;
  const trivial = s.trivialLiteralContexts[blockType >> 5];
  s.trivialLiteralContext = (trivial >>> (blockType & 31)) & 1;
  s.literalHtree = s.literalHgroup.htrees[s.contextMap[contextOffset]];
  const contextMode = s.contextModes[blockType] & 3;
  s.contextLookup = contextMode << 9;
}

function decodeLiteralBlockSwitch(safe, s) {
  if (!decodeBlockTypeAndLength(safe, s, 0)) return false;
  prepareLiteralDecoding(s);
  return true;
}

function decodeCommandBlockSwitch(safe, s) {
  if (!decodeBlockTypeAndLength(safe, s, 1)) return false;
  s.htreeCommand = s.insertCopyHgroup.htrees[s.blockTypeRb[3]];
  return true;
}

function decodeDistanceBlockSwitch(safe, s) {
  if (!decodeBlockTypeAndLength(safe, s, 2)) return false;
  s.distContextMapSlice = s.blockTypeRb[5] << DISTANCE_CONTEXT_BITS;
  s.distHtreeIndex = s.distContextMap[s.distContextMapSlice + s.distanceContext];
  return true;
}

function unwrittenBytes(s, wrap) {
  const pos = wrap && s.pos > s.ringbufferSize ? s.ringbufferSize : s.pos;
  const partialPosRb = s.rbRoundtrips * s.ringbufferSize + pos;
  return partialPosRb - s.partialPosOut;
}

/**
 * Dumps output. NEEDS_MORE_OUTPUT only if there is more output to push and
 * either the ring buffer is as big as the window, or `force` is true.
 */
function writeRingBuffer(s, force) {
  const start = s.partialPosOut % s.ringbufferSize;
  const toWrite = unwrittenBytes(s, true);
  let numWritten = s.availOut;
  if (numWritten > toWrite) numWritten = toWrite;
  if (s.metaBlockRemainingLen < 0) return ERROR_FORMAT_BLOCK_LENGTH_1;
  if (s.hasOut) {
    s.out.set(s.ringbuffer.subarray(start, start + numWritten), s.nextOut);
    s.nextOut += numWritten;
  }
  s.availOut -= numWritten;
  s.partialPosOut += numWritten;
  if (numWritten < toWrite) {
    if (s.ringbufferSize === 1 << s.windowBits || force) return NEEDS_MORE_OUTPUT;
    return SUCCESS;
  }
  // Wrap ring buffer only if it has reached its maximal size.
  if (s.ringbufferSize === 1 << s.windowBits && s.pos >= s.ringbufferSize) {
    s.pos -= s.ringbufferSize;
    s.rbRoundtrips++;
    s.shouldWrapRingbuffer = s.pos !== 0 ? 1 : 0;
  }
  return SUCCESS;
}

function wrapRingBuffer(s) {
  if (s.shouldWrapRingbuffer) {
    s.ringbuffer.copyWithin(0, s.ringbufferEnd, s.ringbufferEnd + s.pos);
    s.shouldWrapRingbuffer = 0;
  }
}

/**
 * Allocates the ring buffer (s.newRingbufferSize). Its last two bytes are 0,
 * so the context of the first two positions is computed as for any other.
 */
function ensureRingBuffer(s) {
  const old = s.ringbuffer;
  if (s.ringbufferSize === s.newRingbufferSize) return true;
  let ringbuffer;
  try {
    ringbuffer = new Uint8Array(s.newRingbufferSize + kRingBufferWriteAheadSlack);
  } catch {
    return false;
  }
  s.ringbuffer = ringbuffer;
  if (old) ringbuffer.set(old.subarray(0, s.pos));
  s.ringbufferSize = s.newRingbufferSize;
  s.ringbufferMask = s.newRingbufferSize - 1;
  s.ringbufferEnd = s.ringbufferSize;
  return true;
}

function skipMetadataBlock(s) {
  if (s.metaBlockRemainingLen === 0) return SUCCESS;
  // Drain the accumulator.
  if (s.bitPos >= 8) {
    let nbytes = s.bitPos >> 3;
    if (nbytes > s.metaBlockRemainingLen) nbytes = s.metaBlockRemainingLen;
    copyBytes(null, 0, s, nbytes);
    s.metaBlockRemainingLen -= nbytes;
    if (s.metaBlockRemainingLen === 0) return SUCCESS;
  }
  // Direct access to metadata is possible.
  let nbytes = remainingBytes(s);
  if (nbytes > s.metaBlockRemainingLen) nbytes = s.metaBlockRemainingLen;
  if (nbytes > 0) {
    s.nextIn += nbytes;
    s.metaBlockRemainingLen -= nbytes;
    if (s.metaBlockRemainingLen === 0) return SUCCESS;
  }
  return NEEDS_MORE_INPUT;
}

function copyUncompressedBlockToOutput(s) {
  if (!ensureRingBuffer(s)) return ERROR_ALLOC_RING_BUFFER_1;
  for (;;) {
    switch (s.substateUncompressed) {
      case UNCOMPRESSED_NONE: {
        let nbytes = remainingBytes(s);
        if (nbytes > s.metaBlockRemainingLen) nbytes = s.metaBlockRemainingLen;
        if (s.pos + nbytes > s.ringbufferSize) nbytes = s.ringbufferSize - s.pos;
        // Copy remaining bytes from the bit reader to the ring buffer.
        copyBytes(s.ringbuffer, s.pos, s, nbytes);
        s.pos += nbytes;
        s.metaBlockRemainingLen -= nbytes;
        if (s.pos < 1 << s.windowBits) {
          if (s.metaBlockRemainingLen === 0) return SUCCESS;
          return NEEDS_MORE_INPUT;
        }
        s.substateUncompressed = UNCOMPRESSED_WRITE;
      }
      // Fall through.
      case UNCOMPRESSED_WRITE: {
        const result = writeRingBuffer(s, false);
        if (result !== SUCCESS) return result;
        if (s.ringbufferSize === 1 << s.windowBits) s.maxDistance = s.maxBackwardDistance;
        s.substateUncompressed = UNCOMPRESSED_NONE;
        break;
      }
    }
  }
}

/**
 * Calculates the smallest feasible ring buffer: when the data is known to be
 * small, no more than needed. Metablock size and flags MUST be decoded.
 */
function calculateRingBufferSize(s) {
  const windowSize = 1 << s.windowBits;
  let newRingbufferSize = windowSize;
  // At least 2 bytes of ring buffer, for the last two bytes of context.
  let minSize = s.ringbufferSize ? s.ringbufferSize : 1024;
  // If maximum is already reached, no further extension is required.
  if (s.ringbufferSize === windowSize) return;
  // Metadata blocks do not touch the ring buffer.
  if (s.isMetadata) return;
  let outputSize = s.ringbuffer ? s.pos : 0;
  outputSize += s.metaBlockRemainingLen;
  minSize = minSize < outputSize ? outputSize : minSize;
  if (s.cannyRingbufferAllocation) {
    // Reduce ring buffer size to save memory when server is unscrupulous.
    while (newRingbufferSize >> 1 >= minSize) newRingbufferSize >>= 1;
  }
  s.newRingbufferSize = newRingbufferSize;
}

/** Reads 1..256 2-bit context modes. */
function readContextModes(s) {
  let i = s.loopCounter;
  while (i < s.numBlockTypes[0]) {
    const bits = safeReadBits(s, 2);
    if (bits < 0) {
      s.loopCounter = i;
      return NEEDS_MORE_INPUT;
    }
    s.contextModes[i] = bits;
    i++;
  }
  return SUCCESS;
}

function takeDistanceFromRingBuffer(s) {
  const offset = s.distanceCode - 3;
  if (s.distanceCode <= 3) {
    // Compensate double distance-ring-buffer roll for dictionary items.
    s.distanceContext = 1 >> s.distanceCode;
    s.distanceCode = s.distRb[(s.distRbIdx - offset) & 3];
    s.distRbIdx -= s.distanceContext;
  } else {
    let indexDelta = 3;
    let base = s.distanceCode - 10;
    if (s.distanceCode < 10) base = s.distanceCode - 4;
    else indexDelta = 2;
    // Unpack one of six 4-bit values.
    const delta = ((0x605142 >> (4 * base)) & 0xf) - 3;
    s.distanceCode = (s.distRb[(s.distRbIdx + indexDelta) & 3] + delta) | 0;
    if (s.distanceCode <= 0) {
      // A huge distance will cause a failure soon. This is a little faster
      // than failing here.
      s.distanceCode = 0x7fffffff;
    }
  }
}

/** Calculates the distance lookup table. */
function calculateDistanceLut(s) {
  const npostfix = s.distancePostfixBits;
  const ndirect = s.numDirectDistanceCodes;
  const alphabetSizeLimit = s.distanceHgroup.alphabetSizeLimit;
  const postfix = 1 << npostfix;
  let bits = 1;
  let half = 0;
  // Skip short codes.
  let i = NUM_DISTANCE_SHORT_CODES;
  // Fill direct codes.
  for (let j = 0; j < ndirect; ++j) {
    s.distExtraBits[i] = 0;
    s.distOffset[i] = j + 1;
    ++i;
  }
  // Fill regular distance codes.
  while (i < alphabetSizeLimit) {
    const base = ndirect + ((((2 + half) << bits) - 4) << npostfix) + 1;
    // Always fill the complete group.
    for (let j = 0; j < postfix; ++j) {
      s.distExtraBits[i] = bits;
      s.distOffset[i] = base + j;
      ++i;
    }
    bits = bits + half;
    half = half ^ 1;
  }
}

/** Reads a distance (s.distanceCode < 0). */
function readDistance(safe, s) {
  const table = s.distanceHgroup.codes;
  const tree = s.distanceHgroup.htrees[s.distHtreeIndex];
  let code;
  let val = 0;
  let bitPos = 0;
  let nextIn = 0;
  if (!safe) {
    code = readSymbol(table, tree, s);
  } else {
    val = s.val;
    bitPos = s.bitPos;
    nextIn = s.nextIn;
    code = safeReadSymbol(table, tree, s);
    if (code < 0) return false;
  }
  --s.blockLength[2];
  // Convert the distance code to the actual distance by possibly looking up
  // past distances from s.distRb.
  s.distanceContext = 0;
  if ((code & ~0xf) === 0) {
    s.distanceCode = code;
    takeDistanceFromRingBuffer(s);
    return true;
  }
  let bits;
  const n = s.distExtraBits[code];
  if (!safe) {
    bits = readBits32(s, n);
  } else {
    bits = n !== 0 ? safeReadBits32(s, n) : 0;
    if (bits < 0) {
      ++s.blockLength[2];
      s.val = val;
      s.bitPos = bitPos;
      s.nextIn = nextIn;
      return false;
    }
  }
  s.distanceCode = (s.distOffset[code] + (bits << s.distancePostfixBits)) | 0;
  return true;
}

/** Reads a command; its insert length is s.insertLength. */
function readCommand(safe, s) {
  let cmdCode;
  let insertLenExtra = 0;
  let copyLength;
  let val = 0;
  let bitPos = 0;
  let nextIn = 0;
  if (!safe) {
    cmdCode = readSymbol(s.insertCopyHgroup.codes, s.htreeCommand, s);
  } else {
    val = s.val;
    bitPos = s.bitPos;
    nextIn = s.nextIn;
    cmdCode = safeReadSymbol(s.insertCopyHgroup.codes, s.htreeCommand, s);
    if (cmdCode < 0) return false;
  }
  s.distanceCode = CMD_DISTANCE_CODE[cmdCode];
  s.distanceContext = CMD_CONTEXT[cmdCode];
  s.distHtreeIndex = s.distContextMap[s.distContextMapSlice + s.distanceContext];
  let insertLength = CMD_INSERT_OFFSET[cmdCode];
  const insertExtraBits = CMD_INSERT_EXTRA[cmdCode];
  const copyExtraBits = CMD_COPY_EXTRA[cmdCode];
  if (!safe) {
    if (insertExtraBits !== 0) insertLenExtra = readBits24(s, insertExtraBits);
    copyLength = readBits24(s, copyExtraBits);
  } else {
    insertLenExtra = insertExtraBits !== 0 ? safeReadBits(s, insertExtraBits) : 0;
    copyLength = insertLenExtra < 0 ? -1 : copyExtraBits !== 0 ? safeReadBits(s, copyExtraBits) : 0;
    if (copyLength < 0) {
      s.val = val;
      s.bitPos = bitPos;
      s.nextIn = nextIn;
      return false;
    }
  }
  s.copyLength = copyLength + CMD_COPY_OFFSET[cmdCode];
  --s.blockLength[1];
  insertLength += insertLenExtra;
  s.insertLength = insertLength;
  return true;
}

/* ProcessCommandsInternal's labels. */
const L_COMMAND_BEGIN = 0;
const L_COMMAND_INNER = 1;
const L_COMMAND_POST_DECODE_LITERALS = 2;
const L_COMMAND_POST_WRAP_COPY = 3;
const L_NEXT_LITERAL_BLOCK = 4;
const L_SAVE_STATE_AND_RETURN = 5;

function processCommands(safe, s) {
  let pos = s.pos;
  let i = s.loopCounter;
  let result = SUCCESS;
  let label;
  const rb = s.ringbuffer;

  if (!safe && !checkInputAmount(s)) {
    result = NEEDS_MORE_INPUT;
    label = L_SAVE_STATE_AND_RETURN;
  } else {
    if (!safe) warmupBitReader(s);
    // Jump into the state machine.
    if (s.state === STATE_COMMAND_BEGIN) label = L_COMMAND_BEGIN;
    else if (s.state === STATE_COMMAND_INNER) label = L_COMMAND_INNER;
    else if (s.state === STATE_COMMAND_POST_DECODE_LITERALS) label = L_COMMAND_POST_DECODE_LITERALS;
    else if (s.state === STATE_COMMAND_POST_WRAP_COPY) label = L_COMMAND_POST_WRAP_COPY;
    else return ERROR_UNREACHABLE;
  }

  for (;;) {
    switch (label) {
      case L_COMMAND_BEGIN: {
        if (safe) s.state = STATE_COMMAND_BEGIN;
        if (!safe && !checkInputAmount(s)) {
          s.state = STATE_COMMAND_BEGIN;
          result = NEEDS_MORE_INPUT;
          label = L_SAVE_STATE_AND_RETURN;
          continue;
        }
        if (s.blockLength[1] === 0) {
          if (!decodeCommandBlockSwitch(safe, s) && safe) {
            result = NEEDS_MORE_INPUT;
            label = L_SAVE_STATE_AND_RETURN;
          }
          continue;
        }
        // Read the insert/copy length in the command.
        if (!readCommand(safe, s) && safe) {
          result = NEEDS_MORE_INPUT;
          label = L_SAVE_STATE_AND_RETURN;
          continue;
        }
        i = s.insertLength;
        if (i === 0) {
          label = L_COMMAND_POST_DECODE_LITERALS;
          continue;
        }
        s.metaBlockRemainingLen -= i;
      }
      // Fall through.
      case L_COMMAND_INNER: {
        if (safe) s.state = STATE_COMMAND_INNER;
        label = -1;
        // Read the literals in the command.
        if (s.trivialLiteralContext) {
          const table = s.literalHgroup.codes;
          const tree = s.literalHtree;
          do {
            if (!safe && !checkInputAmount(s)) {
              s.state = STATE_COMMAND_INNER;
              result = NEEDS_MORE_INPUT;
              label = L_SAVE_STATE_AND_RETURN;
              break;
            }
            if (s.blockLength[0] === 0) {
              label = L_NEXT_LITERAL_BLOCK;
              break;
            }
            if (!safe) {
              rb[pos] = readSymbol(table, tree, s);
            } else {
              const literal = safeReadSymbol(table, tree, s);
              if (literal < 0) {
                result = NEEDS_MORE_INPUT;
                label = L_SAVE_STATE_AND_RETURN;
                break;
              }
              rb[pos] = literal;
            }
            --s.blockLength[0];
            ++pos;
            if (pos === s.ringbufferSize) {
              s.state = STATE_COMMAND_INNER_WRITE;
              --i;
              label = L_SAVE_STATE_AND_RETURN;
              break;
            }
          } while (--i !== 0);
        } else {
          let p1 = rb[(pos - 1) & s.ringbufferMask];
          let p2 = rb[(pos - 2) & s.ringbufferMask];
          const lut = s.contextLookup;
          const table = s.literalHgroup.codes;
          const htrees = s.literalHgroup.htrees;
          const contextMap = s.contextMap;
          const slice = s.contextMapSlice;
          do {
            if (!safe && !checkInputAmount(s)) {
              s.state = STATE_COMMAND_INNER;
              result = NEEDS_MORE_INPUT;
              label = L_SAVE_STATE_AND_RETURN;
              break;
            }
            if (s.blockLength[0] === 0) {
              label = L_NEXT_LITERAL_BLOCK;
              break;
            }
            const context = CONTEXT_LUT[lut + p1] | CONTEXT_LUT[lut + 256 + p2];
            const tree = htrees[contextMap[slice + context]];
            p2 = p1;
            if (!safe) {
              p1 = readSymbol(table, tree, s) & 0xff;
            } else {
              const literal = safeReadSymbol(table, tree, s);
              if (literal < 0) {
                result = NEEDS_MORE_INPUT;
                label = L_SAVE_STATE_AND_RETURN;
                break;
              }
              p1 = literal & 0xff;
            }
            rb[pos] = p1;
            --s.blockLength[0];
            ++pos;
            if (pos === s.ringbufferSize) {
              s.state = STATE_COMMAND_INNER_WRITE;
              --i;
              label = L_SAVE_STATE_AND_RETURN;
              break;
            }
          } while (--i !== 0);
        }
        if (label !== -1) continue;
        if (s.metaBlockRemainingLen <= 0) {
          s.state = STATE_METABLOCK_DONE;
          label = L_SAVE_STATE_AND_RETURN;
          continue;
        }
      }
      // Fall through.
      case L_COMMAND_POST_DECODE_LITERALS: {
        if (safe) s.state = STATE_COMMAND_POST_DECODE_LITERALS;
        if (s.distanceCode >= 0) {
          // Implicit distance case.
          s.distanceContext = s.distanceCode ? 0 : 1;
          --s.distRbIdx;
          s.distanceCode = s.distRb[s.distRbIdx & 3];
        } else {
          // Read the distance code in the command, unless it was implicitly zero.
          if (s.blockLength[2] === 0) {
            if (!decodeDistanceBlockSwitch(safe, s) && safe) {
              result = NEEDS_MORE_INPUT;
              label = L_SAVE_STATE_AND_RETURN;
              continue;
            }
          }
          if (!readDistance(safe, s) && safe) {
            result = NEEDS_MORE_INPUT;
            label = L_SAVE_STATE_AND_RETURN;
            continue;
          }
        }
        if (s.maxDistance !== s.maxBackwardDistance) {
          s.maxDistance = pos < s.maxBackwardDistance ? pos : s.maxBackwardDistance;
        }
        i = s.copyLength;
        // Apply the copy of an LZ77 back-reference, or a static dictionary
        // reference if the distance is larger than the max LZ77 distance.
        if (s.distanceCode > s.maxDistance) {
          // The maximum allowed distance is MAX_ALLOWED_DISTANCE = 0x7FFFFFFC.
          if (s.distanceCode > MAX_ALLOWED_DISTANCE) return ERROR_FORMAT_DISTANCE;
          if (i >= MIN_DICTIONARY_WORD_LENGTH && i <= MAX_DICTIONARY_WORD_LENGTH) {
            let offset = kOffsetsByLength[i];
            const shift = kSizeBitsByLength[i];
            const address = s.distanceCode - s.maxDistance - 1;
            const mask = kBitMask[shift];
            const wordIdx = address & mask;
            const transformIdx = address >> shift;
            // Compensate double distance-ring-buffer roll.
            s.distRbIdx += s.distanceContext;
            offset += wordIdx * i;
            if (kSizeBitsByLength[i] === 0) return ERROR_FORMAT_DICTIONARY;
            const words = dictionary();
            if (!words) return ERROR_DICTIONARY_NOT_SET;
            if (transformIdx < NUM_TRANSFORMS) {
              let len = i;
              if (transformIdx === CUT_OFF_TRANSFORM_0) {
                rb.set(words.subarray(offset, offset + len), pos);
              } else {
                len = transformDictionaryWord(rb, pos, words, offset, len, transformIdx);
                if (len === 0 && s.distanceCode <= 120) return ERROR_FORMAT_TRANSFORM;
              }
              pos += len;
              s.metaBlockRemainingLen -= len;
              if (pos >= s.ringbufferSize) {
                s.state = STATE_COMMAND_POST_WRITE_1;
                label = L_SAVE_STATE_AND_RETURN;
                continue;
              }
            } else {
              return ERROR_FORMAT_TRANSFORM;
            }
          } else {
            return ERROR_FORMAT_DICTIONARY;
          }
        } else {
          const srcStart = (pos - s.distanceCode) & s.ringbufferMask;
          const dstEnd = pos + i;
          const srcEnd = srcStart + i;
          // Update the recent distances cache.
          s.distRb[s.distRbIdx & 3] = s.distanceCode;
          ++s.distRbIdx;
          s.metaBlockRemainingLen -= i;
          // There are 32+ bytes of slack in the ring buffer allocation. Also,
          // 16 short codes make these 16 bytes irrelevant in the ring buffer.
          // Copy over them as a first guess.
          rb.copyWithin(pos, srcStart, srcStart + 16);
          if ((srcEnd > pos && dstEnd > srcStart) || dstEnd >= s.ringbufferSize || srcEnd >= s.ringbufferSize) {
            // The regions intersect, or at least one region wraps.
            label = L_COMMAND_POST_WRAP_COPY;
            continue;
          }
          pos += i;
          if (i > 16) rb.copyWithin(pos - i + 16, srcStart + 16, srcStart + i);
        }
        if (s.metaBlockRemainingLen <= 0) {
          // Next metablock, if any.
          s.state = STATE_METABLOCK_DONE;
          label = L_SAVE_STATE_AND_RETURN;
        } else {
          label = L_COMMAND_BEGIN;
        }
        continue;
      }
      case L_COMMAND_POST_WRAP_COPY: {
        let wrapGuard = s.ringbufferSize - pos;
        label = -1;
        while (--i >= 0) {
          rb[pos] = rb[(pos - s.distanceCode) & s.ringbufferMask];
          ++pos;
          if (--wrapGuard === 0) {
            s.state = STATE_COMMAND_POST_WRITE_2;
            label = L_SAVE_STATE_AND_RETURN;
            break;
          }
        }
        if (label !== -1) continue;
        if (s.metaBlockRemainingLen <= 0) {
          // Next metablock, if any.
          s.state = STATE_METABLOCK_DONE;
          label = L_SAVE_STATE_AND_RETURN;
        } else {
          label = L_COMMAND_BEGIN;
        }
        continue;
      }
      case L_NEXT_LITERAL_BLOCK:
        if (!decodeLiteralBlockSwitch(safe, s) && safe) {
          result = NEEDS_MORE_INPUT;
          label = L_SAVE_STATE_AND_RETURN;
          continue;
        }
        label = L_COMMAND_INNER;
        continue;
      case L_SAVE_STATE_AND_RETURN:
        s.pos = pos;
        s.loopCounter = i;
        return result;
    }
  }
}

/** BrotliDecoderStateMetablockBegin. */
function metablockBegin(s) {
  s.metaBlockRemainingLen = 0;
  s.blockLength[0] = BLOCK_SIZE_CAP;
  s.blockLength[1] = BLOCK_SIZE_CAP;
  s.blockLength[2] = BLOCK_SIZE_CAP;
  s.numBlockTypes[0] = 1;
  s.numBlockTypes[1] = 1;
  s.numBlockTypes[2] = 1;
  s.blockTypeRb[0] = 1;
  s.blockTypeRb[1] = 0;
  s.blockTypeRb[2] = 1;
  s.blockTypeRb[3] = 0;
  s.blockTypeRb[4] = 1;
  s.blockTypeRb[5] = 0;
  s.contextMap = null;
  s.contextModes = null;
  s.distContextMap = null;
  s.contextMapSlice = 0;
  s.literalHtree = 0;
  s.distContextMapSlice = 0;
  s.distHtreeIndex = 0;
  s.contextLookup = 0;
  s.literalHgroup = null;
  s.insertCopyHgroup = null;
  s.distanceHgroup = null;
}

/** BrotliCalculateDistanceCodeLimit's max_alphabet_size. */
function distanceCodeLimit(maxDistance, npostfix, ndirect) {
  if (maxDistance <= ndirect) return maxDistance + NUM_DISTANCE_SHORT_CODES;
  // The first prohibited value.
  const forbiddenDistance = maxDistance + 1;
  // Subtract the "directly" encoded region.
  let offset = forbiddenDistance - ndirect - 1;
  let ndistbits = 0;
  const postfix = (1 << npostfix) - 1;
  // Remove postfix and "head-start".
  offset = (offset >>> npostfix) + 4;
  // Calculate the number of distance bits.
  let tmp = Math.floor(offset / 2);
  while (tmp !== 0) {
    ndistbits++;
    tmp >>>= 1;
  }
  // One bit is covered with subrange addressing ("half").
  ndistbits--;
  // Find the subrange.
  const half = (offset >>> ndistbits) & 1;
  // Calculate the "group" part of the dcode.
  let group = ((ndistbits - 1) << 1) | half;
  if (group === 0) return ndirect + NUM_DISTANCE_SHORT_CODES;
  // Decrement "group", so it is the last permitted "group".
  group--;
  return ((group << npostfix) | postfix) + ndirect + NUM_DISTANCE_SHORT_CODES + 1;
}

/**
 * BrotliDecoderDecompressStream. The input is input[inOff, inOff +
 * s.availIn), the output s.out[s.nextOut, s.nextOut + s.availOut); both are
 * updated (s.availIn: the input left).
 */
function decompressStream(s, input, inOff) {
  let result = SUCCESS;
  // Where the input stream is: input[nextIn, nextIn + availIn).
  let nextIn = inOff;
  let availIn = s.availIn;
  // Do not try to process further in a case of unrecoverable error.
  if (s.errorCode < 0) return RESULT_ERROR;
  s.hasOut = s.availOut !== 0;
  if (s.bufferLength === 0) {
    // Just connect the bit reader to the input stream.
    setInput(s, input, nextIn, availIn);
  } else {
    // At least one byte of input is required. More than one byte of input may
    // be required to complete the transaction -> reading more data must be
    // done in a loop -> do it in the main loop.
    result = NEEDS_MORE_INPUT;
    setInput(s, s.buffer, 0, s.bufferLength);
  }
  const done = (code) => {
    s.availIn = availIn;
    return saveErrorCode(s, code);
  };
  // State machine.
  for (;;) {
    if (result !== SUCCESS) {
      // Error, needs more input/output.
      if (result === NEEDS_MORE_INPUT) {
        if (s.ringbuffer) {
          // Pro-actively push output.
          const intermediate = writeRingBuffer(s, true);
          // writeRingBuffer checks s.metaBlockRemainingLen validity.
          if (intermediate < 0) {
            result = intermediate;
            break;
          }
        }
        if (s.bufferLength !== 0) {
          // Used with the internal buffer.
          if (s.nextIn === s.lastIn) {
            // Successfully finished the read transaction. The accumulator
            // has fewer than 8 bits, because the internal buffer is expanded
            // byte by byte until it is enough to complete the read.
            s.bufferLength = 0;
            // Switch to the input stream and restart.
            result = SUCCESS;
            setInput(s, input, nextIn, availIn);
            continue;
          } else if (availIn !== 0) {
            // Not enough data in the buffer, but one more byte can be taken
            // from the input stream.
            result = SUCCESS;
            s.buffer[s.bufferLength] = input[nextIn];
            s.bufferLength++;
            setInput(s, s.buffer, 0, s.bufferLength);
            nextIn++;
            availIn--;
            // Retry with more data in the buffer.
            continue;
          }
          // Can't finish reading and no more input.
          break;
        } else {
          // The input stream doesn't contain enough input: copy the tail to
          // the internal buffer and return.
          nextIn = s.nextIn;
          availIn = s.lastIn - s.nextIn;
          while (availIn) {
            s.buffer[s.bufferLength] = input[nextIn];
            s.bufferLength++;
            nextIn++;
            availIn--;
          }
          break;
        }
      }
      // Fail or needs more output.
      if (s.bufferLength !== 0) {
        // Just consumed the buffered input and produced some output.
        // Otherwise it would result in "needs more input". Reset the
        // internal buffer.
        s.bufferLength = 0;
      } else {
        // Using the input stream in the last iteration. When the decoder
        // switches to the input stream it has fewer than 8 bits in the
        // accumulator, so it is safe to return unused accumulator bits there.
        bitReaderUnload(s);
        availIn = s.lastIn - s.nextIn;
        nextIn = s.nextIn;
      }
      break;
    }
    switch (s.state) {
      case STATE_UNINITED:
        // Prepare to the first read.
        if (!warmupBitReader(s)) {
          result = NEEDS_MORE_INPUT;
          break;
        }
        // Decode window size.
        result = decodeWindowBits(s); // Reads 1..8 bits.
        if (result !== SUCCESS) break;
        if (s.largeWindow) {
          s.state = STATE_LARGE_WINDOW_BITS;
          break;
        }
        s.state = STATE_INITIALIZE;
        break;

      case STATE_LARGE_WINDOW_BITS: {
        const bits = safeReadBits(s, 6);
        if (bits < 0) {
          result = NEEDS_MORE_INPUT;
          break;
        }
        s.windowBits = bits & 63;
        if (s.windowBits < LARGE_MIN_WBITS || s.windowBits > LARGE_MAX_WBITS) {
          result = ERROR_FORMAT_WINDOW_BITS;
          break;
        }
        s.state = STATE_INITIALIZE;
      }
      // Fall through.
      case STATE_INITIALIZE:
        // Maximum distance, see section 9.1. of the spec.
        s.maxBackwardDistance = (1 << s.windowBits) - WINDOW_GAP;
        // Allocate memory for both block_type_trees and block_len_trees.
        s.blockTrees = new Int32Array(3 * (HUFFMAN_MAX_SIZE_258 + HUFFMAN_MAX_SIZE_26));
        s.state = STATE_METABLOCK_BEGIN;
      // Fall through.
      case STATE_METABLOCK_BEGIN:
        metablockBegin(s);
        s.state = STATE_METABLOCK_HEADER;
      // Fall through.
      case STATE_METABLOCK_HEADER:
        result = decodeMetaBlockLength(s); // Reads 2 - 31 bits.
        if (result !== SUCCESS) break;
        if (s.isMetadata || s.isUncompressed) {
          if (!jumpToByteBoundary(s)) {
            result = ERROR_FORMAT_PADDING_1;
            break;
          }
        }
        if (s.isMetadata) {
          s.state = STATE_METADATA;
          break;
        }
        if (s.metaBlockRemainingLen === 0) {
          s.state = STATE_METABLOCK_DONE;
          break;
        }
        calculateRingBufferSize(s);
        if (s.isUncompressed) {
          s.state = STATE_UNCOMPRESSED;
          break;
        }
        s.state = STATE_BEFORE_COMPRESSED_METABLOCK_HEADER;
      // Fall through.
      case STATE_BEFORE_COMPRESSED_METABLOCK_HEADER:
        s.loopCounter = 0;
        // Initialize the compressed metablock header arena.
        s.hSubLoopCounter = 0;
        s.hSubstateHuffman = HUFFMAN_NONE;
        s.hSubstateTreeGroup = TREE_GROUP_NONE;
        s.hSubstateContextMap = CONTEXT_MAP_NONE;
        s.state = STATE_HUFFMAN_CODE_0;
      // Fall through.
      case STATE_HUFFMAN_CODE_0:
        if (s.loopCounter >= 3) {
          s.state = STATE_METABLOCK_HEADER_2;
          break;
        }
        // Reads 1..11 bits.
        result = decodeVarLenUint8(s, s.numBlockTypes, s.loopCounter);
        if (result !== SUCCESS) break;
        s.numBlockTypes[s.loopCounter]++;
        if (s.numBlockTypes[s.loopCounter] < 2) {
          s.loopCounter++;
          break;
        }
        s.state = STATE_HUFFMAN_CODE_1;
      // Fall through.
      case STATE_HUFFMAN_CODE_1: {
        const alphabetSize = s.numBlockTypes[s.loopCounter] + 2;
        const treeOffset = s.loopCounter * HUFFMAN_MAX_SIZE_258;
        result = readHuffmanCode(alphabetSize, alphabetSize, s.blockTrees, treeOffset, s);
        if (result !== SUCCESS) break;
        s.state = STATE_HUFFMAN_CODE_2;
      }
      // Fall through.
      case STATE_HUFFMAN_CODE_2: {
        const treeOffset = BLOCK_LEN_TREES + s.loopCounter * HUFFMAN_MAX_SIZE_26;
        result = readHuffmanCode(NUM_BLOCK_LEN_SYMBOLS, NUM_BLOCK_LEN_SYMBOLS, s.blockTrees, treeOffset, s);
        if (result !== SUCCESS) break;
        s.state = STATE_HUFFMAN_CODE_3;
      }
      // Fall through.
      case STATE_HUFFMAN_CODE_3: {
        const treeOffset = BLOCK_LEN_TREES + s.loopCounter * HUFFMAN_MAX_SIZE_26;
        const length = safeReadBlockLength(s, s.blockTrees, treeOffset);
        if (length < 0) {
          result = NEEDS_MORE_INPUT;
          break;
        }
        s.blockLength[s.loopCounter] = length;
        s.loopCounter++;
        s.state = STATE_HUFFMAN_CODE_0;
        break;
      }

      case STATE_UNCOMPRESSED:
        result = copyUncompressedBlockToOutput(s);
        if (result !== SUCCESS) break;
        s.state = STATE_METABLOCK_DONE;
        break;

      case STATE_METADATA:
        result = skipMetadataBlock(s);
        if (result !== SUCCESS) break;
        s.state = STATE_METABLOCK_DONE;
        break;

      case STATE_METABLOCK_HEADER_2: {
        let bits = safeReadBits(s, 6);
        if (bits < 0) {
          result = NEEDS_MORE_INPUT;
          break;
        }
        s.distancePostfixBits = bits & 3;
        bits >>= 2;
        s.numDirectDistanceCodes = bits << s.distancePostfixBits;
        s.contextModes = new Uint8Array(s.numBlockTypes[0]);
        s.loopCounter = 0;
        s.state = STATE_CONTEXT_MODES;
      }
      // Fall through.
      case STATE_CONTEXT_MODES:
        result = readContextModes(s);
        if (result !== SUCCESS) break;
        s.state = STATE_CONTEXT_MAP_1;
      // Fall through.
      case STATE_CONTEXT_MAP_1:
        result = decodeContextMap(s.numBlockTypes[0] << LITERAL_CONTEXT_BITS, 0, s);
        if (result !== SUCCESS) break;
        detectTrivialLiteralBlockTypes(s);
        s.state = STATE_CONTEXT_MAP_2;
      // Fall through.
      case STATE_CONTEXT_MAP_2: {
        const npostfix = s.distancePostfixBits;
        const ndirect = s.numDirectDistanceCodes;
        let distanceAlphabetSizeMax = distanceAlphabetSize(npostfix, ndirect, MAX_DISTANCE_BITS);
        let distanceAlphabetSizeLimit = distanceAlphabetSizeMax;
        if (s.largeWindow) {
          distanceAlphabetSizeMax = distanceAlphabetSize(npostfix, ndirect, LARGE_MAX_DISTANCE_BITS);
          distanceAlphabetSizeLimit = distanceCodeLimit(MAX_ALLOWED_DISTANCE, npostfix, ndirect);
        }
        result = decodeContextMap(s.numBlockTypes[2] << DISTANCE_CONTEXT_BITS, 1, s);
        if (result !== SUCCESS) break;
        s.literalHgroup = new TreeGroup(NUM_LITERAL_SYMBOLS, NUM_LITERAL_SYMBOLS, s.numHtrees[0]);
        s.insertCopyHgroup = new TreeGroup(NUM_COMMAND_SYMBOLS, NUM_COMMAND_SYMBOLS, s.numBlockTypes[1]);
        s.distanceHgroup = new TreeGroup(distanceAlphabetSizeMax, distanceAlphabetSizeLimit, s.numHtrees[1]);
        s.loopCounter = 0;
        s.state = STATE_TREE_GROUP;
      }
      // Fall through.
      case STATE_TREE_GROUP: {
        const hgroup =
          s.loopCounter === 0 ? s.literalHgroup : s.loopCounter === 1 ? s.insertCopyHgroup : s.distanceHgroup;
        result = huffmanTreeGroupDecode(hgroup, s);
        if (result !== SUCCESS) break;
        s.loopCounter++;
        if (s.loopCounter < 3) break;
        s.state = STATE_BEFORE_COMPRESSED_METABLOCK_BODY;
      }
      // Fall through.
      case STATE_BEFORE_COMPRESSED_METABLOCK_BODY:
        prepareLiteralDecoding(s);
        s.distContextMapSlice = 0;
        s.htreeCommand = s.insertCopyHgroup.htrees[0];
        if (!ensureRingBuffer(s)) {
          result = ERROR_ALLOC_RING_BUFFER_2;
          break;
        }
        calculateDistanceLut(s);
        s.state = STATE_COMMAND_BEGIN;
      // Fall through.
      case STATE_COMMAND_BEGIN:
      case STATE_COMMAND_INNER:
      case STATE_COMMAND_POST_DECODE_LITERALS:
      case STATE_COMMAND_POST_WRAP_COPY:
        result = processCommands(false, s);
        if (result === NEEDS_MORE_INPUT) result = processCommands(true, s);
        break;

      case STATE_COMMAND_INNER_WRITE:
      case STATE_COMMAND_POST_WRITE_1:
      case STATE_COMMAND_POST_WRITE_2:
        result = writeRingBuffer(s, false);
        if (result !== SUCCESS) break;
        wrapRingBuffer(s);
        if (s.ringbufferSize === 1 << s.windowBits) s.maxDistance = s.maxBackwardDistance;
        if (s.state === STATE_COMMAND_POST_WRITE_1) {
          if (s.metaBlockRemainingLen === 0) {
            // Next metablock, if any.
            s.state = STATE_METABLOCK_DONE;
          } else {
            s.state = STATE_COMMAND_BEGIN;
          }
          break;
        } else if (s.state === STATE_COMMAND_POST_WRITE_2) {
          s.state = STATE_COMMAND_POST_WRAP_COPY;
        } else {
          // STATE_COMMAND_INNER_WRITE
          if (s.loopCounter === 0) {
            if (s.metaBlockRemainingLen === 0) s.state = STATE_METABLOCK_DONE;
            else s.state = STATE_COMMAND_POST_DECODE_LITERALS;
            break;
          }
          s.state = STATE_COMMAND_INNER;
        }
        break;

      case STATE_METABLOCK_DONE:
        if (s.metaBlockRemainingLen < 0) {
          result = ERROR_FORMAT_BLOCK_LENGTH_2;
          break;
        }
        // BrotliDecoderStateCleanupAfterMetablock.
        s.contextModes = null;
        s.contextMap = null;
        s.distContextMap = null;
        s.literalHgroup = null;
        s.insertCopyHgroup = null;
        s.distanceHgroup = null;
        if (!s.isLastMetablock) {
          s.state = STATE_METABLOCK_BEGIN;
          break;
        }
        if (!jumpToByteBoundary(s)) {
          result = ERROR_FORMAT_PADDING_2;
          break;
        }
        if (s.bufferLength === 0) {
          bitReaderUnload(s);
          availIn = s.lastIn - s.nextIn;
          nextIn = s.nextIn;
        }
        s.state = STATE_DONE;
      // Fall through.
      case STATE_DONE:
        if (s.ringbuffer) {
          result = writeRingBuffer(s, true);
          if (result !== SUCCESS) break;
        }
        return done(result);
    }
  }
  return done(result);
}

/** A decoder, as Node's BrotliDecoderContext holds one. */
export class BrotliDecoder {
  constructor() {
    this.state = new State();
  }

  /** BrotliDecoderSetParameter. */
  setParameter(param, value) {
    return this.state.setParameter(param, value);
  }

  /**
   * One BrotliDecoderDecompressStream call: returns the BrotliDecoderResult;
   * `availIn` and `availOut` are what is left of each.
   */
  decompress(input, inOff, inLen, output, outOff, outLen) {
    const s = this.state;
    const result = s.decompressStream(input, inOff, inLen, output, outOff, outLen);
    this.availIn = s.availIn;
    this.availOut = s.availOut;
    return result;
  }

  /** BrotliDecoderGetErrorCode. */
  get errorCode() {
    return this.state.errorCode;
  }
}
