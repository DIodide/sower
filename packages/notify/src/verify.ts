import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * DER/SPKI prefix that wraps a 32-byte raw Ed25519 public key so it can be
 * loaded as a KeyObject: SEQUENCE(SEQUENCE(OID 1.3.101.112), BIT STRING).
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toBuffer(data: string | Buffer | Uint8Array): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Verify a Discord interaction request signature (Ed25519).
 *
 * @param publicKey hex-encoded 32-byte Ed25519 public key (from the Discord
 *   application settings; non-secret)
 * @param signature hex-encoded 64-byte signature (X-Signature-Ed25519 header)
 * @param timestamp X-Signature-Timestamp header value
 * @param rawBody the RAW request body, exactly as received (a re-serialized
 *   JSON body will not verify)
 * @returns true only when the signature is valid; any malformed input
 *   returns false rather than throwing
 */
export function verifyInteraction(
  publicKey: string,
  signature: string,
  timestamp: string,
  rawBody: string | Buffer | Uint8Array,
): boolean {
  try {
    const keyBytes = Buffer.from(publicKey, 'hex');
    if (keyBytes.length !== 32) return false;
    const signatureBytes = Buffer.from(signature, 'hex');
    if (signatureBytes.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
      format: 'der',
      type: 'spki',
    });
    const message = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      toBuffer(rawBody),
    ]);
    return cryptoVerify(null, message, key, signatureBytes);
  } catch {
    return false;
  }
}
