import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCORD_PUBLIC_KEY } from './config.js';
import { verifyInteraction } from './verify.js';

function makeSigned(timestamp: string, body: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKeyHex = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  const signature = cryptoSign(
    null,
    Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body, 'utf8')]),
    privateKey,
  ).toString('hex');
  return { rawPublicKeyHex, signature };
}

describe('verifyInteraction', () => {
  const timestamp = '1752300000';
  const body = JSON.stringify({ type: 1 });

  it('accepts a correctly signed payload (string body)', () => {
    const { rawPublicKeyHex, signature } = makeSigned(timestamp, body);
    expect(verifyInteraction(rawPublicKeyHex, signature, timestamp, body)).toBe(
      true,
    );
  });

  it('accepts a correctly signed payload (Buffer and Uint8Array bodies)', () => {
    const { rawPublicKeyHex, signature } = makeSigned(timestamp, body);
    expect(
      verifyInteraction(
        rawPublicKeyHex,
        signature,
        timestamp,
        Buffer.from(body),
      ),
    ).toBe(true);
    expect(
      verifyInteraction(
        rawPublicKeyHex,
        signature,
        timestamp,
        new TextEncoder().encode(body),
      ),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { rawPublicKeyHex, signature } = makeSigned(timestamp, body);
    expect(
      verifyInteraction(
        rawPublicKeyHex,
        signature,
        timestamp,
        JSON.stringify({ type: 2 }),
      ),
    ).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const { rawPublicKeyHex, signature } = makeSigned(timestamp, body);
    expect(
      verifyInteraction(rawPublicKeyHex, signature, '1752300001', body),
    ).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const { rawPublicKeyHex, signature } = makeSigned(timestamp, body);
    const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
    expect(verifyInteraction(rawPublicKeyHex, flipped, timestamp, body)).toBe(
      false,
    );
  });

  it('rejects a signature from a different key', () => {
    const { signature } = makeSigned(timestamp, body);
    const { rawPublicKeyHex: otherKey } = makeSigned(timestamp, body);
    expect(verifyInteraction(otherKey, signature, timestamp, body)).toBe(false);
  });

  it('returns false (never throws) on malformed inputs', () => {
    const { rawPublicKeyHex, signature } = makeSigned(timestamp, body);
    expect(verifyInteraction('not-hex', signature, timestamp, body)).toBe(
      false,
    );
    expect(verifyInteraction('abcd', signature, timestamp, body)).toBe(false);
    expect(verifyInteraction(rawPublicKeyHex, 'zz', timestamp, body)).toBe(
      false,
    );
    expect(verifyInteraction(rawPublicKeyHex, '', timestamp, body)).toBe(false);
    expect(verifyInteraction('', '', '', '')).toBe(false);
  });

  it('works against the committed default public key shape (random sig rejected)', () => {
    expect(
      verifyInteraction(
        DEFAULT_DISCORD_PUBLIC_KEY,
        'ab'.repeat(64),
        timestamp,
        body,
      ),
    ).toBe(false);
  });
});
