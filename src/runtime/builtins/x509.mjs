/**
 * X.509 for tls: a DER certificate as Node 22.22.0's getPeerCertificate()
 * shows it (src/crypto/crypto_x509.cc's X509ToObject, ncrypto's
 * PrintGeneralName, lib/_tls_common.js's translatePeerCertificate), and the
 * issuer test OpenSSL's X509_check_issued makes, for the chain Node links.
 * The kernel hands jsh the server's chain as DER (slicc-kernel 1.124.0,
 * ai-ecoverse/slicc-kernel#922); this is what reads it.
 */

// --- DER ----------------------------------------------------------------
function tlv(bytes, at) {
  const tag = bytes[at];
  let len = bytes[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[start + i];
    start += n;
  }
  const end = start + len;
  if (!(end <= bytes.length) || Number.isNaN(end)) throw new Error('bad DER');
  return { tag, at, start, end };
}

function children(bytes, node) {
  const out = [];
  for (let at = node.start; at < node.end; ) {
    const c = tlv(bytes, at);
    out.push(c);
    at = c.end;
  }
  return out;
}

const content = (bytes, node) => bytes.subarray(node.start, node.end);

function oidText(b) {
  const parts = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      if (parts.length === 0) {
        const first = v < 80 ? Math.floor(v / 40) : 2;
        parts.push(first, v - first * 40);
      } else parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

const latin1 = (b) => String.fromCharCode(...b);
const utf8 = (b) => new TextDecoder().decode(b);

/** ASN1_STRING_to_UTF8: the string's characters, whatever its type. */
function stringValue(bytes, node) {
  const b = content(bytes, node);
  switch (node.tag) {
    case 0x1e: {
      let s = '';
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    case 0x1c: {
      let s = '';
      for (let i = 0; i + 3 < b.length; i += 4) s += String.fromCodePoint(((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
      return s;
    }
    case 0x14:
      return latin1(b);
    default:
      return utf8(b);
  }
}

// OpenSSL's short names for the attributes a name carries (OBJ_nid2sn).
const NAME_SN = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'street',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.13': 'description',
  '2.5.4.15': 'businessCategory',
  '2.5.4.17': 'postalCode',
  '2.5.4.41': 'name',
  '2.5.4.42': 'GN',
  '2.5.4.43': 'initials',
  '2.5.4.44': 'generationQualifier',
  '2.5.4.46': 'dnQualifier',
  '2.5.4.65': 'pseudonym',
  '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
  '1.3.6.1.4.1.311.60.2.1.1': 'jurisdictionL',
  '1.3.6.1.4.1.311.60.2.1.2': 'jurisdictionST',
  '1.3.6.1.4.1.311.60.2.1.3': 'jurisdictionC',
};

/** A Name's entries, in order: [[key, value, canonical]]. */
function nameEntries(bytes, node) {
  const out = [];
  for (const rdn of children(bytes, node)) {
    for (const ava of children(bytes, rdn)) {
      const [type, value] = children(bytes, ava);
      const oid = oidText(content(bytes, type));
      const text = stringValue(bytes, value);
      out.push([NAME_SN[oid] ?? oid, text, `${oid}=${text.trim().replace(/\s+/g, ' ').toLowerCase()}`]);
    }
  }
  return out;
}

/** GetX509NameObject: a null-prototype object, an array for a repeated key. */
function nameObject(entries) {
  const o = Object.create(null);
  for (const [k, v] of entries) {
    if (!(k in o)) o[k] = v;
    else if (Array.isArray(o[k])) o[k].push(v);
    else o[k] = [o[k], v];
  }
  return o;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ASN1_TIME_print: "Jan  2 03:04:05 2026 GMT". */
function timeText(bytes, node) {
  const s = latin1(content(bytes, node));
  const m =
    node.tag === 0x17
      ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s)
      : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(\.\d+)?Z$/.exec(s);
  if (!m) return 'Bad time value';
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  const pad = (n) => String(n).padStart(2, '0');
  const frac = m[7] && m[7].length > 1 ? m[7] : '';
  return `${MONTHS[Number(m[2]) - 1]} ${String(Number(m[3])).padStart(2, ' ')} ${pad(Number(m[4]))}:${pad(Number(m[5]))}:${pad(Number(m[6] ?? 0))}${frac} ${year} GMT`;
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** ncrypto's PrintAltName: a safe name as is, else JSON-quoted. */
function altName(b, utf8Option = false) {
  let safe = true;
  for (const c of b) {
    if (c === 0x22 || c === 0x5c || c === 0x2c || c === 0x27) safe = false;
    else if (utf8Option ? c < 0x20 || c === 0x7f : c < 0x20 || c > 0x7e) safe = false;
    if (!safe) break;
  }
  if (safe) return utf8Option ? utf8(b) : latin1(b);
  let out = '"';
  for (const c of b) {
    if (c === 0x5c) out += '\\\\';
    else if (c === 0x22) out += '\\"';
    else if ((c >= 0x20 && c !== 0x2c && c <= 0x7e) || (utf8Option && c & 0x80)) out += String.fromCharCode(c);
    else out += `\\u00${c.toString(16).padStart(2, '0')}`;
  }
  out += '"';
  return utf8Option ? utf8(Uint8Array.from(out, (ch) => ch.charCodeAt(0))) : out;
}

/** ncrypto's PrintGeneralName. */
function generalName(bytes, node) {
  const b = content(bytes, node);
  switch (node.tag) {
    case 0x82:
      return `DNS:${altName(b)}`;
    case 0x81:
      return `email:${altName(b)}`;
    case 0x86:
      return `URI:${altName(b)}`;
    case 0x87:
      if (b.length === 4) return `IP Address:${b.join('.')}`;
      if (b.length === 16) {
        const words = [];
        for (let j = 0; j < 8; j++) words.push(((b[2 * j] << 8) | b[2 * j + 1]).toString(16).toUpperCase());
        return `IP Address:${words.join(':')}`;
      }
      return `IP Address:<invalid length=${b.length}>`;
    case 0x88:
      return `Registered ID:${oidText(b)}`;
    case 0xa4:
      return `DirName:${altName(new TextEncoder().encode(rfc2253(bytes, children(bytes, node)[0])), true)}`;
    case 0xa0:
      return 'othername:<unsupported>';
    case 0xa3:
      return 'X400Name:<unsupported>';
    case 0xa5:
      return 'EdiPartyName:<unsupported>';
    default:
      return '';
  }
}

/** X509_NAME_print_ex with RFC 2253 order (last RDN first), for DirName. */
function rfc2253(bytes, node) {
  return nameEntries(bytes, node)
    .reverse()
    .map(([k, v]) => `${k}=${v.replace(/([,+"\\<>;])/g, '\\$1')}`)
    .join(',');
}

// AuthorityInfoAccess methods (i2t_ASN1_OBJECT's long names).
const ACCESS_METHOD = { '1.3.6.1.5.5.7.48.1': 'OCSP', '1.3.6.1.5.5.7.48.2': 'CA Issuers' };

const CURVES = {
  '1.2.840.10045.3.1.7': ['prime256v1', 'P-256', 256],
  '1.3.132.0.34': ['secp384r1', 'P-384', 384],
  '1.3.132.0.35': ['secp521r1', 'P-521', 521],
  '1.3.132.0.10': ['secp256k1', undefined, 256],
  '1.3.132.0.33': ['secp224r1', 'P-224', 224],
  '1.2.840.10045.3.1.1': ['prime192v1', 'P-192', 192],
  '1.3.36.3.3.2.8.1.1.7': ['brainpoolP256r1', undefined, 256],
  '1.3.36.3.3.2.8.1.1.11': ['brainpoolP384r1', undefined, 384],
  '1.3.36.3.3.2.8.1.1.13': ['brainpoolP512r1', undefined, 512],
};

/** An INTEGER's magnitude without its leading zero bytes. */
function magnitude(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

function bitLength(b) {
  const m = magnitude(b);
  if (m.length === 0 || (m.length === 1 && m[0] === 0)) return 0;
  return (m.length - 1) * 8 + (32 - Math.clz32(m[0]));
}

/** A certificate's parts, from its DER. */
export function parseCertificate(der) {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const cert = tlv(bytes, 0);
  const [tbsNode] = children(bytes, cert);
  const tbs = children(bytes, tbsNode);
  let i = 0;
  if (tbs[0].tag === 0xa0) i++;
  const serial = content(bytes, tbs[i]);
  const issuerNode = tbs[i + 2];
  const validity = children(bytes, tbs[i + 3]);
  const subjectNode = tbs[i + 4];
  const spkiNode = tbs[i + 5];
  const out = {
    der: bytes,
    serial,
    issuer: nameEntries(bytes, issuerNode),
    subject: nameEntries(bytes, subjectNode),
    notBefore: timeText(bytes, validity[0]),
    notAfter: timeText(bytes, validity[1]),
    spki: bytes.subarray(spkiNode.at, spkiNode.end),
    key: undefined,
    san: undefined,
    infoAccess: undefined,
    basicCA: undefined,
    keyUsage: undefined,
    eku: undefined,
    ski: undefined,
    akid: undefined,
  };
  // SubjectPublicKeyInfo: RSA's modulus and exponent, or an EC curve and point.
  const [alg, bits] = children(bytes, spkiNode);
  const [algOid, params] = children(bytes, alg);
  const keyBits = content(bytes, bits).subarray(1);
  const algorithm = oidText(content(bytes, algOid));
  if (algorithm === '1.2.840.113549.1.1.1') {
    const rsa = tlv(keyBits, 0);
    const [n, e] = children(keyBits, rsa);
    out.key = { type: 'rsa', n: content(keyBits, n), e: content(keyBits, e) };
  } else if (algorithm === '1.2.840.10045.2.1' && params?.tag === 0x06) {
    out.key = { type: 'ec', curve: oidText(content(bytes, params)), point: keyBits };
  }
  const extsNode = tbs.find((n) => n.tag === 0xa3);
  if (extsNode) {
    for (const ext of children(bytes, children(bytes, extsNode)[0])) {
      const parts = children(bytes, ext);
      const id = oidText(content(bytes, parts[0]));
      const value = content(bytes, parts[parts.length - 1]);
      const inner = tlv(value, 0);
      if (id === '2.5.29.17' && out.san === undefined) {
        out.san = children(value, inner).map((g) => generalName(value, g)).join(', ');
      } else if (id === '1.3.6.1.5.5.7.1.1' && out.infoAccess === undefined) {
        out.infoAccess = children(value, inner)
          .map((desc) => {
            const [method, location] = children(value, desc);
            const m = oidText(content(value, method));
            return `${ACCESS_METHOD[m] ?? m} - ${generalName(value, location)}`;
          })
          .join('\n');
      } else if (id === '2.5.29.19') {
        const first = children(value, inner)[0];
        out.basicCA = first?.tag === 0x01 && value[first.start] !== 0;
      } else if (id === '2.5.29.15') {
        const b = content(value, inner);
        out.keyUsage = (b[1] ?? 0) | ((b[2] ?? 0) << 8);
      } else if (id === '2.5.29.37') {
        out.eku = children(value, inner).map((o) => oidText(content(value, o)));
      } else if (id === '2.5.29.14') {
        out.ski = hex(content(value, inner));
      } else if (id === '2.5.29.35') {
        const keyId = children(value, inner).find((n) => n.tag === 0x80);
        if (keyId) out.akid = hex(content(value, keyId));
      }
    }
  }
  return out;
}

const KU_KEY_CERT_SIGN = 0x04;

/** X509_check_ca() === 1: a CA by basicConstraints, allowed to sign certificates. */
function isCA(c) {
  if (c.keyUsage !== undefined && !(c.keyUsage & KU_KEY_CERT_SIGN)) return false;
  return c.basicCA === true;
}

const sameName = (a, b) => a.length === b.length && a.every((e, i) => e[2] === b[i][2]);

/** ossl_x509_likely_issued: the names and key identifiers match (no key usage). */
export function likelyIssued(cert, issuer) {
  if (!sameName(cert.issuer, issuer.subject)) return false;
  return !(cert.akid && issuer.ski && cert.akid !== issuer.ski);
}

/** X509_check_issued(issuer, cert) === X509_V_OK. */
export function isIssuedBy(cert, issuer) {
  if (!sameName(cert.issuer, issuer.subject)) return false;
  if (cert.akid && issuer.ski && cert.akid !== issuer.ski) return false;
  if (issuer.keyUsage !== undefined && !(issuer.keyUsage & KU_KEY_CERT_SIGN)) return false;
  return true;
}

/**
 * X509ToObject, then translatePeerCertificate's infoAccess: Node's
 * certificate object, its keys in Node's order.
 */
export function certificateObject(c, { Buffer, digest }) {
  const info = {};
  info.subject = nameObject(c.subject);
  info.issuer = nameObject(c.issuer);
  if (c.san !== undefined) info.subjectaltname = c.san;
  if (c.infoAccess !== undefined) {
    const access = Object.create(null);
    c.infoAccess.replace(/([^\n:]*):([^\n]*)(?:\n|$)/g, (all, key, val) => {
      if (val.charCodeAt(0) === 0x22) val = JSON.parse(val);
      if (key in access) access[key].push(val);
      else access[key] = [val];
      return all;
    });
    info.infoAccess = access;
  }
  info.ca = isCA(c);
  if (c.key?.type === 'rsa') {
    const n = magnitude(c.key.n);
    info.modulus = hex(n).toUpperCase().replace(/^0+(?=.)/, '');
    info.bits = bitLength(c.key.n);
    info.exponent = `0x${BigInt(`0x${hex(magnitude(c.key.e)) || '0'}`).toString(16)}`;
    info.pubkey = Buffer.from(c.spki);
  } else if (c.key?.type === 'ec') {
    const curve = CURVES[c.key.curve];
    if (curve) info.bits = curve[2];
    info.pubkey = Buffer.from(c.key.point);
    if (curve) {
      info.asn1Curve = curve[0];
      if (curve[1] !== undefined) info.nistCurve = curve[1];
    }
  }
  info.valid_from = c.notBefore;
  info.valid_to = c.notAfter;
  const print = (algorithm) => digest(algorithm, c.der).toUpperCase().match(/../g).join(':');
  info.fingerprint = print('sha1');
  info.fingerprint256 = print('sha256');
  info.fingerprint512 = print('sha512');
  if (c.eku !== undefined) info.ext_key_usage = c.eku;
  const serial = magnitude(c.serial);
  info.serialNumber = serial.length === 1 && serial[0] === 0 ? '0' : hex(serial).toUpperCase();
  info.raw = Buffer.from(c.der);
  return info;
}
