import { describe, expect, it } from 'vitest';
import { buildValidationError } from '../../src/challenge/validation_error';

describe('buildValidationError', () => {
  it('emits a minimal body with just code and message', () => {
    const body = buildValidationError({ code: 'bad_request', message: 'Missing fields' });
    expect(body).toEqual({ error: { code: 'bad_request', message: 'Missing fields' } });
    expect(body).not.toHaveProperty('required_fields');
    expect(body).not.toHaveProperty('next_steps');
  });

  it('includes required_fields and example_body when provided', () => {
    const body = buildValidationError({
      code: 'bad_request',
      message: 'product_id and email are required',
      requiredFields: { product_id: 'uuid', email: 'string' },
      exampleBody: { product_id: 'abc', email: 'a@b.c' },
    });
    expect(body.required_fields).toEqual({ product_id: 'uuid', email: 'string' });
    expect(body.example_body).toEqual({ product_id: 'abc', email: 'a@b.c' });
  });

  it('includes next_steps with arbitrary keys', () => {
    const body = buildValidationError({
      code: 'not_found',
      message: 'Product not found',
      nextSteps: { action: 'fetch_catalog', catalog_url: 'https://example.com/catalog' },
    });
    expect(body.next_steps).toEqual({ action: 'fetch_catalog', catalog_url: 'https://example.com/catalog' });
  });

  it('merges extra top-level fields (e.g. available, max_length)', () => {
    const body = buildValidationError({
      code: 'out_of_stock',
      message: 'Insufficient quantity',
      extra: { available: 3, max_length: 300 },
    });
    expect(body.available).toBe(3);
    expect(body.max_length).toBe(300);
  });

  it('omits example_body when undefined but keeps it when null (intentional null)', () => {
    const minimal = buildValidationError({ code: 'x', message: 'y' });
    expect(minimal).not.toHaveProperty('example_body');

    const withNull = buildValidationError({ code: 'x', message: 'y', exampleBody: null });
    expect(withNull.example_body).toBeNull();
  });
});
