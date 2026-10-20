/**
 * Test certificates, built as DER here (Node has no X.509 writer): a CA and
 * leaves it signs, ECDSA P-256 or RSA, with the names and extensions a test
 * asks for. After slicc-kernel's test/integration/test-certs.mjs
 * (ai-ecoverse/slicc-kernel#995), with RSA keys, more names and AIA.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const cat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

function length(n) {
  if (n < 0x80) return Buffer.of(n);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.of(0x80 | bytes.length, ...bytes);
}

const tlv = (tag, ...parts) => {
  const body = cat(parts);
  return cat([Buffer.of(tag), length(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octets = (b) => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.of(unused), b);
const TRUE = Buffer.of(0x01, 0x01, 0xff);
const NULL = Buffer.of(0x05, 0x00);

function integer(magnitude) {
  let b = Buffer.from(magnitude);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? cat([Buffer.of(0), b]) : b);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const groups = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      groups.unshift(v % 128);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(out));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const RSA_SHA256 = seq(oid('1.2.840.113549.1.1.11'), NULL);

function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(0x17, Buffer.from(`${iso}Z`));
}

const ATTRS = { CN: '2.5.4.3', C: '2.5.4.6', ST: '2.5.4.8', L: '2.5.4.7', O: '2.5.4.10', OU: '2.5.4.11' };

/** A Name from [[key, value]] (C as PrintableString, the rest UTF8String). */
const name = (entries) =>
  seq(...entries.map(([k, v]) => set(seq(oid(ATTRS[k] ?? k), tlv(k === 'C' ? 0x13 : 0x0c, Buffer.from(v))))));

const extension = (id, critical, value) =>
  critical ? seq(oid(id), TRUE, octets(value)) : seq(oid(id), octets(value));

// Any stable key id does: the leaf's authorityKeyIdentifier names its CA's.
const keyId = (spki) => createHash('sha1').update(spki).digest();

function ipBytes(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? Buffer.from(m.slice(1).map(Number)) : undefined;
}

/** A subjectAltName entry: 'DNS:x', 'IP:1.2.3.4', 'email:x', 'URI:x'. */
function generalName(entry) {
  const [kind, ...rest] = entry.split(':');
  const value = rest.join(':');
  if (kind === 'DNS') return tlv(0x82, Buffer.from(value));
  if (kind === 'IP') return tlv(0x87, ipBytes(value));
  if (kind === 'email') return tlv(0x81, Buffer.from(value));
  if (kind === 'URI') return tlv(0x86, Buffer.from(value));
  throw new Error(`unknown name ${entry}`);
}

function certificate(o) {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const exts = [extension('2.5.29.14', false, octets(keyId(o.spki)))];
  if (o.ca) {
    exts.push(extension('2.5.29.19', true, seq(TRUE)));
    exts.push(extension('2.5.29.15', true, bits(Buffer.of(0x06), 1)));
  } else {
    if (o.issuerSpki) exts.push(extension('2.5.29.35', false, seq(tlv(0x80, keyId(o.issuerSpki)))));
    // keyUsage: digitalSignature, or [byte, unused bits] as asked.
    const [ku, unused] = o.keyUsage ?? [0x80, 7];
    exts.push(extension('2.5.29.15', true, bits(Buffer.of(ku), unused)));
    exts.push(extension('2.5.29.37', false, seq(...(o.eku ?? ['1.3.6.1.5.5.7.3.1']).map(oid))));
    const sans = o.san ?? [ipBytes(o.host) ? `IP:${o.host}` : `DNS:${o.host}`];
    exts.push(extension('2.5.29.17', false, seq(...sans.map(generalName))));
    if (o.aia) {
      const access = [];
      if (o.aia.ocsp) access.push(seq(oid('1.3.6.1.5.5.7.48.1'), tlv(0x86, Buffer.from(o.aia.ocsp))));
      if (o.aia.caIssuers) access.push(seq(oid('1.3.6.1.5.5.7.48.2'), tlv(0x86, Buffer.from(o.aia.caIssuers))));
      exts.push(extension('1.3.6.1.5.5.7.1.1', false, seq(...access)));
    }
  }
  const alg = o.rsa ? RSA_SHA256 : ECDSA_SHA256;
  const tbs = seq(
    tlv(0xa0, integer(Buffer.of(2))),
    integer(serial),
    alg,
    name(o.issuer),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.subject),
    Buffer.from(o.spki),
    tlv(0xa3, seq(...exts))
  );
  return seq(tbs, alg, bits(sign('sha256', tbs, o.key)));
}

export function pem(der) {
  const lines = Buffer.from(der)
    .toString('base64')
    .match(/.{1,64}/g);
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

const DAY = 86400_000;
const pair = (rsa) => (rsa ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' }));

/**
 * A CA (`rsa`: an RSA key), and `server(host, options)` for a leaf it signs:
 * `{ der, cert (leaf + CA, PEM), key }`. Options: notBefore, notAfter, san
 * (list), eku (OIDs), subject ([[key, value]]), aia ({ ocsp, caIssuers }), rsa.
 * `notCa`: the issuer is a self-signed leaf (no CA:true, no keyCertSign), so
 * what it signs verifies under no chain check.
 */
export function makeCa(cn = 'slicc-jsh test CA', { rsa = false, notCa = false } = {}) {
  const { privateKey, publicKey } = pair(rsa);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const subject = [['CN', cn]];
  const der = certificate({
    issuer: subject,
    subject,
    notBefore: new Date(now - DAY),
    notAfter: new Date(now + 365 * DAY),
    spki,
    ca: !notCa,
    host: notCa ? 'not-a-ca.test' : undefined,
    key: privateKey,
    rsa,
  });
  return {
    der,
    pem: pem(der),
    server(host, { notBefore = new Date(now - 3600_000), notAfter = new Date(now + 7 * DAY), san, eku, keyUsage, subject: names, aia, rsa: leafRsa = false } = {}) {
      const leafKeys = pair(leafRsa);
      const leaf = certificate({
        issuer: subject,
        subject: names ?? [['CN', host]],
        notBefore,
        notAfter,
        spki: leafKeys.publicKey.export({ type: 'spki', format: 'der' }),
        issuerSpki: spki,
        host,
        san,
        eku,
        keyUsage,
        aia,
        key: privateKey,
        rsa,
      });
      return {
        der: leaf,
        cert: pem(leaf) + pem(der),
        leafOnly: pem(leaf),
        key: leafKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      };
    },
  };
}

/** A self-signed leaf (no CA): Node's DEPTH_ZERO_SELF_SIGNED_CERT. */
export function selfSigned(host) {
  const { privateKey, publicKey } = pair(false);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const der = certificate({
    issuer: [['CN', host]],
    subject: [['CN', host]],
    notBefore: new Date(now - DAY),
    notAfter: new Date(now + DAY),
    spki,
    host,
    key: privateKey,
  });
  return { der, cert: pem(der), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
