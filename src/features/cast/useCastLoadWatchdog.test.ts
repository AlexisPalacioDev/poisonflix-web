import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAST_LOAD_TIMEOUT_MS, useCastLoadWatchdog } from './useCastLoadWatchdog';

// The screen-level behaviour lives in `CastScreen.timeout.test.tsx`, which is
// where it belongs - a television does not care what a hook returns.
//
// What is HERE is the one part of the contract that renders identically either
// way, and is therefore invisible from the DOM: whether a timer is armed at
// all while the screen is not waiting for anything. `CastScreen` never shows
// the expired state behind a playing video regardless, because that branch
// sits behind an earlier return - so an adversarial review deleted the
// `'ready'` guard and the whole suite still passed. A guard nothing can kill
// is a guard that will be deleted by someone tidying up.

describe('useCastLoadWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires once the phase has been waiting for the whole budget', () => {
    const { result } = renderHook(() => useCastLoadWatchdog('viewer'));
    expect(result.current.state).toBe('waiting');

    act(() => {
      vi.advanceTimersByTime(CAST_LOAD_TIMEOUT_MS);
    });

    expect(result.current.state).toBe('expired');
  });

  it('arms no timer at all while nothing is being waited for', () => {
    const { result } = renderHook(() => useCastLoadWatchdog('ready'));

    act(() => {
      vi.advanceTimersByTime(CAST_LOAD_TIMEOUT_MS * 10);
    });

    expect(result.current.state).toBe('waiting');
    // Not "no message appeared" - that would pass with the guard gone. The
    // clock ran ten times over and the watchdog never left `'waiting'`.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the clock over when the screen moves on to the next wait', () => {
    const { result, rerender } = renderHook(({ phase }: { phase: 'viewer' | 'stream' | 'ready' }) =>
      useCastLoadWatchdog(phase),
    { initialProps: { phase: 'viewer' as const } });

    act(() => {
      vi.advanceTimersByTime(CAST_LOAD_TIMEOUT_MS - 1);
    });
    rerender({ phase: 'stream' });

    // The second wait is not charged for the first one's nineteen seconds.
    act(() => {
      vi.advanceTimersByTime(CAST_LOAD_TIMEOUT_MS - 1);
    });
    expect(result.current.state).toBe('waiting');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe('expired');
  });

  it('re-arms on restart, so a retry is not judged by the failed attempt', () => {
    const { result } = renderHook(() => useCastLoadWatchdog('viewer'));
    act(() => {
      vi.advanceTimersByTime(CAST_LOAD_TIMEOUT_MS);
    });
    expect(result.current.state).toBe('expired');

    act(() => {
      result.current.restart();
    });

    expect(result.current.state).toBe('waiting');
    act(() => {
      vi.advanceTimersByTime(CAST_LOAD_TIMEOUT_MS - 1);
    });
    expect(result.current.state).toBe('waiting');
  });

  it('leaves no timer behind when it unmounts', () => {
    const { unmount } = renderHook(() => useCastLoadWatchdog('viewer'));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
