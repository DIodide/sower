import { describe, expect, it } from 'vitest';
import {
  assertSafeFetchTarget,
  isForbiddenHost,
  isPrivateIp,
  isSafeRequestTarget,
} from './ssrf.js';

describe('isPrivateIp', () => {
  it('flags private/loopback/link-local/CGNAT IPv4', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('flags IPv6 loopback/ULA/link-local and IPv4-mapped forms', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('passes public addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '172.32.0.1',
      '1.1.1.1',
      '2607:f8b0::1',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('assertSafeFetchTarget', () => {
  it('accepts normal public https URLs', () => {
    expect(() =>
      assertSafeFetchTarget('https://apply.workable.com/acme/j/ABC123/'),
    ).not.toThrow();
  });

  it('rejects non-http(s), localhost, private IPs, and internal suffixes', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'http://localhost:3000/',
      'http://sub.localhost/',
      'http://foo.local/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://169.254.169.254/',
      'http://[::1]/',
      'http://192.168.0.10/',
      'not a url',
    ]) {
      expect(() => assertSafeFetchTarget(url), url).toThrow();
    }
  });
});

describe('isForbiddenHost', () => {
  it('handles bracketed IPv6 literals', () => {
    expect(isForbiddenHost('[::1]')).toBe(true);
    expect(isForbiddenHost('[fe80::1]')).toBe(true);
  });
});

describe('isSafeRequestTarget', () => {
  it('rejects forbidden hosts without a DNS lookup', async () => {
    const cache = new Map<string, boolean>();
    expect(await isSafeRequestTarget('http://10.9.8.7/asset.js', cache)).toBe(
      false,
    );
    expect(await isSafeRequestTarget('http://foo.internal/x', cache)).toBe(
      false,
    );
    // Literal checks never populate the DNS cache.
    expect(cache.size).toBe(0);
  });

  it('rejects non-http(s) and malformed URLs', async () => {
    const cache = new Map<string, boolean>();
    expect(await isSafeRequestTarget('ws://example.com/socket', cache)).toBe(
      false,
    );
    expect(await isSafeRequestTarget('not a url', cache)).toBe(false);
  });

  it('honors a cached per-host verdict (no re-resolution)', async () => {
    const cache = new Map<string, boolean>([
      ['cdn.example.com', true],
      ['evil.example.com', false],
    ]);
    expect(
      await isSafeRequestTarget('https://cdn.example.com/app.js', cache),
    ).toBe(true);
    expect(await isSafeRequestTarget('https://evil.example.com/x', cache)).toBe(
      false,
    );
  });
});
