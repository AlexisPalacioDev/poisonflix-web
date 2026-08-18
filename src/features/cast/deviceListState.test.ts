import { describe, expect, it } from 'vitest';
import { deviceListState, type DeviceListInputs } from './deviceListState';

// Every one of these would go green again if the corresponding branch were
// deleted from a chain of ternaries inside JSX - which is exactly what
// happened before this logic was pulled out here.

const READY: DeviceListInputs = {
  urlsReady: true,
  deviceCount: 0,
  isFetching: false,
  hasScanned: false,
  isError: false,
};

describe('deviceListState', () => {
  it('refuses before anything else when no castable URL exists', () => {
    expect(
      deviceListState({ ...READY, urlsReady: false, deviceCount: 3, hasScanned: true, isError: true }),
    ).toBe('unavailable');
  });

  // The regression a mutation proved the component tests could not see: the
  // query is disabled until the sheet opens, so this exact combination - no
  // devices, no request in flight, no scan finished - is a real render.
  it('reads "not asked yet" as scanning, never as an empty network', () => {
    expect(deviceListState({ ...READY, isFetching: false, hasScanned: false })).toBe('scanning');
  });

  it('reads a finished scan with nothing in it as empty', () => {
    expect(deviceListState({ ...READY, hasScanned: true })).toBe('empty');
  });

  it('keeps showing "scanning" while a scan is in flight', () => {
    expect(deviceListState({ ...READY, isFetching: true, hasScanned: true })).toBe('scanning');
  });

  it('reports a failed scan when it has nothing else to show', () => {
    expect(deviceListState({ ...READY, hasScanned: true, isError: true })).toBe('error');
  });

  // A "Buscar de nuevo" with bad luck must not destroy a good list.
  it('keeps the devices it already found when a re-scan fails', () => {
    expect(deviceListState({ ...READY, deviceCount: 2, hasScanned: true, isError: true })).toBe('list');
  });

  it('keeps the devices it already found while a re-scan is running', () => {
    expect(deviceListState({ ...READY, deviceCount: 2, hasScanned: true, isFetching: true })).toBe('list');
  });
});
