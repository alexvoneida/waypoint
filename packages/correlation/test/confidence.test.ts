import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreConfidence,
  metresPerSecond,
  GAP_HIGH_MAX_SECONDS,
  GAP_MEDIUM_MAX_SECONDS,
  SPEED_HIGH_MAX_MPS,
  SPEED_MEDIUM_MAX_MPS,
} from '../src/confidence.ts';

test('gap boundary: just under high threshold is high', () => {
  const result = scoreConfidence({ gapSeconds: GAP_HIGH_MAX_SECONDS - 1, speedMetresPerSecond: 0 });
  assert.equal(result, 'high');
});

test('gap boundary: exactly at high threshold is medium', () => {
  const result = scoreConfidence({ gapSeconds: GAP_HIGH_MAX_SECONDS, speedMetresPerSecond: 0 });
  assert.equal(result, 'medium');
});

test('gap boundary: exactly at medium max is still medium', () => {
  const result = scoreConfidence({ gapSeconds: GAP_MEDIUM_MAX_SECONDS, speedMetresPerSecond: 0 });
  assert.equal(result, 'medium');
});

test('gap boundary: just over medium max is low', () => {
  const result = scoreConfidence({ gapSeconds: GAP_MEDIUM_MAX_SECONDS + 1, speedMetresPerSecond: 0 });
  assert.equal(result, 'low');
});

test('speed boundary: just under high threshold is high', () => {
  const result = scoreConfidence({ gapSeconds: 0, speedMetresPerSecond: SPEED_HIGH_MAX_MPS - 0.1 });
  assert.equal(result, 'high');
});

test('speed boundary: exactly at high threshold is medium', () => {
  const result = scoreConfidence({ gapSeconds: 0, speedMetresPerSecond: SPEED_HIGH_MAX_MPS });
  assert.equal(result, 'medium');
});

test('speed boundary: exactly at medium max is still medium', () => {
  const result = scoreConfidence({ gapSeconds: 0, speedMetresPerSecond: SPEED_MEDIUM_MAX_MPS });
  assert.equal(result, 'medium');
});

test('speed boundary: just over medium max is low', () => {
  const result = scoreConfidence({ gapSeconds: 0, speedMetresPerSecond: SPEED_MEDIUM_MAX_MPS + 0.1 });
  assert.equal(result, 'low');
});

test('overall confidence is the minimum across both signals', () => {
  const highGapLowSpeed = scoreConfidence({ gapSeconds: 1000, speedMetresPerSecond: 0.1 });
  assert.equal(highGapLowSpeed, 'low');

  const lowGapHighSpeed = scoreConfidence({ gapSeconds: 1, speedMetresPerSecond: 10 });
  assert.equal(lowGapHighSpeed, 'low');

  const bothMedium = scoreConfidence({ gapSeconds: 30, speedMetresPerSecond: 2 });
  assert.equal(bothMedium, 'medium');
});

test('null gap is treated as low regardless of speed', () => {
  const result = scoreConfidence({ gapSeconds: null, speedMetresPerSecond: 0.1 });
  assert.equal(result, 'low');
});

test('metresPerSecond does not divide by zero on a zero-duration segment', () => {
  assert.equal(metresPerSecond(50, 0), 0);
  assert.equal(metresPerSecond(0, 0), 0);
});

test('a real hike with routine gaps up to 18s scores no worse than medium', () => {
  const result = scoreConfidence({ gapSeconds: 18, speedMetresPerSecond: 1.5 });
  assert.equal(result, 'medium');
});
