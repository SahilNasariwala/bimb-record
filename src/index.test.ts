import { describe, expect, it } from 'vitest';
import { keyLabel, pickMime, toVideoTime } from './index';

describe('toVideoTime', () => {
  const ev = (t: number) => ({ t });
  it('shifts by t0 and removes paused time; drops events before t0 or inside a pause', () => {
    const out = toVideoTime([ev(900), ev(1100), ev(1600), ev(2500), ev(1300)], 1000, [[1500, 2000]]);
    expect(out.map(e => e.t)).toEqual([100, 300, 1000]);
  });
  it('handles no pauses', () => expect(toVideoTime([ev(1500)], 1000, []).map(e => e.t)).toEqual([500]));
});

describe('keyLabel', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ repeat: false, target: null, code: '', ...o }) as KeyboardEvent;
  it('labels shortcuts', () => {
    expect(keyLabel(k({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBe('Ctrl+K');
    expect(keyLabel(k({ key: 'Ω', code: 'KeyZ', altKey: true }), true)).toBe('⌥Z');
    expect(keyLabel(k({ key: 'Escape' }), false)).toBe('Esc');
  });
  it('never records plain typing, modifiers alone, repeats or password fields', () => {
    expect(keyLabel(k({ key: 'a' }), false)).toBeUndefined();
    expect(keyLabel(k({ key: 'Shift', shiftKey: true }), false)).toBeUndefined();
    expect(keyLabel(k({ key: 'k', ctrlKey: true, repeat: true }), false)).toBeUndefined();
    expect(keyLabel(k({ key: 'Enter', target: { type: 'password' } as unknown as EventTarget }), false)).toBeUndefined();
  });
});

it('pickMime prefers vp9 and falls back to plain webm', () => {
  expect(pickMime(true, () => true)).toBe('video/webm;codecs=vp9,opus');
  expect(pickMime(false, t => t === 'video/webm')).toBe('video/webm');
});
