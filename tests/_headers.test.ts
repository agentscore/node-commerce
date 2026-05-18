import { describe, expect, it } from 'vitest';
import { normalizeHeadersToLowercase } from '../src/_headers';

describe('normalizeHeadersToLowercase', () => {
  it('lowercases all keys + preserves values', () => {
    expect(normalizeHeadersToLowercase({ 'Content-Type': 'json', 'X-Foo': 'bar' })).toEqual({
      'content-type': 'json',
      'x-foo': 'bar',
    });
  });

  it('is idempotent', () => {
    const once = normalizeHeadersToLowercase({ 'Content-Type': 'json' });
    expect(normalizeHeadersToLowercase(once)).toEqual(once);
  });

  it('returns empty for empty input', () => {
    expect(normalizeHeadersToLowercase({})).toEqual({});
  });
});
