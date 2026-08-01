import { describe, expect, it } from 'vitest';
import {
  formatSeekStep,
  nextSeekStep,
  newSeekRun,
  RESET_AFTER_MS,
  type SeekRun,
} from './seekAccelerator';

describe('seekAccelerator', () => {
  const press = (run: SeekRun, at: number) => nextSeekStep(run, at);

  it('climbs the ladder during a sustained run and holds at the top', () => {
    let run = newSeekRun();
    const steps: number[] = [];
    let now = 1_000;
    for (let i = 0; i < 20; i += 1) {
      const result = press(run, now);
      steps.push(result.seconds);
      run = result.run;
      now += 100;
    }
    expect(steps.slice(0, 3)).toEqual([5, 5, 5]);
    expect(steps.slice(3, 6)).toEqual([10, 10, 10]);
    expect(steps.slice(6, 9)).toEqual([30, 30, 30]);
    expect(steps[steps.length - 1]).toBe(300);
  });

  it('resets after a pause so a later careful tap is fine again', () => {
    let run = newSeekRun();
    let now = 1_000;
    for (let i = 0; i < 12; i += 1) {
      run = press(run, now).run;
      now += 100;
    }
    const lastPress = now - 100;
    expect(press(run, lastPress + RESET_AFTER_MS + 1).seconds).toBe(5);
  });

  it('keeps the run going across a gap shorter than the reset', () => {
    let run = newSeekRun();
    let now = 1_000;
    for (let i = 0; i < 3; i += 1) {
      run = press(run, now).run;
      now += 100;
    }
    const lastPress = now - 100;
    expect(press(run, lastPress + RESET_AFTER_MS - 1).seconds).toBe(10);
  });

  it('starts fine on the very first press', () => {
    expect(press(newSeekRun(), 123_456).seconds).toBe(5);
  });

  it('formats the step in the coarsest exact unit', () => {
    expect(formatSeekStep(5)).toBe('5s');
    expect(formatSeekStep(30)).toBe('30s');
    expect(formatSeekStep(60)).toBe('1min');
    expect(formatSeekStep(300)).toBe('5min');
  });
});
