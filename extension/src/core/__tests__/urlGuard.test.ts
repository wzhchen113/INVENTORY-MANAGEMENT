import { describe, it, expect } from 'vitest';
import { isSafeHttpUrl, safeOrigin } from '../urlGuard';

describe('isSafeHttpUrl (AC-9 — validate scheme before any navigation)', () => {
  it('accepts http and https', () => {
    expect(isSafeHttpUrl('https://www.bjs.com/product/123')).toBe(true);
    expect(isSafeHttpUrl('http://127.0.0.1:54321')).toBe(true);
  });

  it('rejects javascript:, data:, file: and other schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com')).toBe(false);
  });

  it('rejects null, empty, and unparseable input', () => {
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('safeOrigin', () => {
  it('returns the origin for a safe URL', () => {
    expect(safeOrigin('https://www.samsclub.com/s/milk')).toBe('https://www.samsclub.com');
  });
  it('returns null for an unsafe or unparseable URL', () => {
    expect(safeOrigin('javascript:void(0)')).toBeNull();
    expect(safeOrigin(null)).toBeNull();
    expect(safeOrigin('garbage')).toBeNull();
  });
});
