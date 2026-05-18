import { describe, expect, it } from 'vitest';
import {
  SETTLEMENT_OVERRIDES_HEADER,
  settlementOverrideHeader,
} from '../../src/payment/settlement_override';

describe('settlementOverrideHeader', () => {
  it('emits {name: "Settlement-Overrides", value: JSON-encoded body}', () => {
    expect(settlementOverrideHeader({ amount: '1500' })).toEqual({
      name: 'Settlement-Overrides',
      value: '{"amount":"1500"}',
    });
  });

  it('passes through percentage strings', () => {
    expect(settlementOverrideHeader({ amount: '50%' })).toEqual({
      name: 'Settlement-Overrides',
      value: '{"amount":"50%"}',
    });
  });

  it('passes through dollar-price strings', () => {
    expect(settlementOverrideHeader({ amount: '$0.05' })).toEqual({
      name: 'Settlement-Overrides',
      value: '{"amount":"$0.05"}',
    });
  });

  it('exposes the canonical header name constant', () => {
    expect(SETTLEMENT_OVERRIDES_HEADER).toBe('Settlement-Overrides');
  });
});
