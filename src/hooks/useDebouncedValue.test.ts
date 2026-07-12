import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire before 350ms of quiet elapses (below minimum settle time)', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 350), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'ab' });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe('a');
  });

  it('rapid retyping resets the timer so only the final value settles', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 350), {
      initialProps: { value: 'm' },
    });

    rerender({ value: 'ma' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'mat' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: 'matrix' });

    // Total elapsed since the last keystroke is still < 350ms - no settle yet.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('m');

    // Now let the final value's own 350ms window fully elapse.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe('matrix');
  });

  it('settles and fires once after 350ms of quiet', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 350), {
      initialProps: { value: '' },
    });

    rerender({ value: 'matrix' });
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(result.current).toBe('matrix');
  });
});
