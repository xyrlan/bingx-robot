import { describe, it, expect } from 'vitest';
import { toPrecision, toQuantityPrecision, toSafeIdString } from '@/services/bingx.service';

describe('toPrecision', () => {
  it('should floor to specified decimals', () => {
    expect(toPrecision(1.23456, 2)).toBe('1.23');
    expect(toPrecision(1.999, 2)).toBe('1.99');
    expect(toPrecision(0.001, 4)).toBe('0.0010');
  });

  it('should handle zero', () => {
    expect(toPrecision(0, 4)).toBe('0.0000');
  });

  it('should handle large numbers', () => {
    expect(toPrecision(12345.6789, 2)).toBe('12345.67');
  });
});

describe('toQuantityPrecision', () => {
  it('should ceil to specified decimals', () => {
    expect(toQuantityPrecision(1.231, 2)).toBe('1.24');
    expect(toQuantityPrecision(1.001, 2)).toBe('1.01');
  });

  it('should handle exact values', () => {
    expect(toQuantityPrecision(1.20, 2)).toBe('1.20');
  });

  it('should handle small quantities', () => {
    expect(toQuantityPrecision(0.00014, 4)).toBe('0.0002');
  });
});

describe('toSafeIdString', () => {
  it('should handle string values', () => {
    expect(toSafeIdString('12345')).toBe('12345');
  });

  it('should handle number values', () => {
    expect(toSafeIdString(12345)).toBe('12345');
  });

  it('should handle bigint values', () => {
    expect(toSafeIdString(BigInt('123456789012345678'))).toBe('123456789012345678');
  });

  it('should return undefined for null/undefined', () => {
    expect(toSafeIdString(null)).toBeUndefined();
    expect(toSafeIdString(undefined)).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    expect(toSafeIdString('')).toBeUndefined();
    expect(toSafeIdString('  ')).toBeUndefined();
  });

  it('should trim whitespace', () => {
    expect(toSafeIdString(' 12345 ')).toBe('12345');
  });
});
