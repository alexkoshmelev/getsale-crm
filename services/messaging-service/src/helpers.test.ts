import { describe, it, expect } from 'vitest';
import { isUrlAllowedForUnfurl } from './helpers';

describe('isUrlAllowedForUnfurl', () => {
  it('allows public https URLs', () => {
    expect(isUrlAllowedForUnfurl('https://example.com/path')).toBe(true);
    expect(isUrlAllowedForUnfurl('https://api.github.com')).toBe(true);
  });

  it('allows public http URLs', () => {
    expect(isUrlAllowedForUnfurl('http://example.org')).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(isUrlAllowedForUnfurl('not-a-url')).toBe(false);
    expect(isUrlAllowedForUnfurl('')).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    expect(isUrlAllowedForUnfurl('file:///etc/passwd')).toBe(false);
    expect(isUrlAllowedForUnfurl('ftp://example.com')).toBe(false);
  });

  it('rejects localhost', () => {
    expect(isUrlAllowedForUnfurl('http://localhost/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://localhost:3000')).toBe(false);
    expect(isUrlAllowedForUnfurl('https://127.0.0.1/')).toBe(false);
  });

  it('rejects .local and .internal hostnames', () => {
    expect(isUrlAllowedForUnfurl('http://redis.internal/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://svc.local/')).toBe(false);
  });

  it('rejects internal service hostnames', () => {
    expect(isUrlAllowedForUnfurl('http://redis/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://postgres:5432/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://api-gateway/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://auth-service/')).toBe(false);
  });

  it('rejects private IPv4 ranges', () => {
    expect(isUrlAllowedForUnfurl('http://10.0.0.1/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://192.168.1.1/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://172.16.0.1/')).toBe(false);
    expect(isUrlAllowedForUnfurl('http://169.254.1.1/')).toBe(false);
  });

  it('rejects IPv6 loopback', () => {
    expect(isUrlAllowedForUnfurl('http://[::1]/')).toBe(false);
  });
});
