import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportPlaying, reportProgress, reportStopped } from '../api/jellyfin';
import { usePlaybackHeartbeat } from './usePlaybackHeartbeat';

vi.mock('../api/jellyfin', () => ({
  reportPlaying: vi.fn().mockResolvedValue(undefined),
  reportProgress: vi.fn().mockResolvedValue(undefined),
  reportStopped: vi.fn().mockResolvedValue(undefined),
}));

const mockedReportPlaying = vi.mocked(reportPlaying);
const mockedReportProgress = vi.mocked(reportProgress);
const mockedReportStopped = vi.mocked(reportStopped);

describe('usePlaybackHeartbeat (player spec: "Playback progress heartbeat")', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedReportPlaying.mockClear();
    mockedReportProgress.mockClear();
    mockedReportStopped.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports Sessions/Playing exactly once on start, even if start is called twice', () => {
    const { result } = renderHook(() =>
      usePlaybackHeartbeat({ itemId: 'item-1', playSessionId: 'sess-1', getPositionSeconds: () => 0 }),
    );

    act(() => {
      result.current.onPlay();
      result.current.onPlay();
    });

    expect(mockedReportPlaying).toHaveBeenCalledTimes(1);
    expect(mockedReportPlaying).toHaveBeenCalledWith({
      itemId: 'item-1',
      playSessionId: 'sess-1',
      playMethod: 'DirectPlay',
      positionTicks: 0,
    });
  });

  it('reports Sessions/Progress on a ~10s cadence while playing, using the freshest position', () => {
    let position = 0;
    const { result } = renderHook(() =>
      usePlaybackHeartbeat({ itemId: 'item-1', playSessionId: 'sess-1', getPositionSeconds: () => position }),
    );

    act(() => {
      result.current.onPlay();
    });

    position = 10;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockedReportProgress).toHaveBeenCalledTimes(1);
    expect(mockedReportProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: 'item-1', playSessionId: 'sess-1', positionTicks: 100_000_000 }),
    );

    position = 20;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockedReportProgress).toHaveBeenCalledTimes(2);
    expect(mockedReportProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ positionTicks: 200_000_000 }),
    );
  });

  it('reports Sessions/Stopped and clears the interval on pause - no further Progress reports after that', () => {
    const { result } = renderHook(() =>
      usePlaybackHeartbeat({ itemId: 'item-1', playSessionId: 'sess-1', getPositionSeconds: () => 30 }),
    );

    act(() => {
      result.current.onPlay();
    });
    act(() => {
      result.current.onPause();
    });

    expect(mockedReportStopped).toHaveBeenCalledTimes(1);
    expect(mockedReportStopped).toHaveBeenCalledWith({
      itemId: 'item-1',
      playSessionId: 'sess-1',
      positionTicks: 300_000_000,
    });

    mockedReportProgress.mockClear();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockedReportProgress).not.toHaveBeenCalled();
  });

  it('reports Sessions/Stopped exactly once on unmount, clearing the interval', () => {
    const { result, unmount } = renderHook(() =>
      usePlaybackHeartbeat({ itemId: 'item-1', playSessionId: 'sess-1', getPositionSeconds: () => 45 }),
    );

    act(() => {
      result.current.onPlay();
    });

    unmount();

    expect(mockedReportStopped).toHaveBeenCalledTimes(1);
    expect(mockedReportStopped).toHaveBeenCalledWith({
      itemId: 'item-1',
      playSessionId: 'sess-1',
      positionTicks: 450_000_000,
    });

    mockedReportProgress.mockClear();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mockedReportProgress).not.toHaveBeenCalled();
  });

  it('does not report Stopped on unmount if playback never started', () => {
    const { unmount } = renderHook(() =>
      usePlaybackHeartbeat({ itemId: 'item-1', playSessionId: 'sess-1', getPositionSeconds: () => 0 }),
    );

    unmount();

    expect(mockedReportStopped).not.toHaveBeenCalled();
  });
});
