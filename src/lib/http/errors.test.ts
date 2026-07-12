import { describe, expect, it } from 'vitest';
import { ApiError, CorsError, isApiError, isNetworkError, NetworkError } from './errors';

describe('ApiError vs NetworkError distinction', () => {
  it('ApiError carries the HTTP status and an optional body', () => {
    const err = new ApiError(401, 'Unauthorized', { message: 'bad token' });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect(err.status).toBe(401);
    expect(err.body).toEqual({ message: 'bad token' });
    expect(isApiError(err)).toBe(true);
    expect(isNetworkError(err)).toBe(false);
  });

  it('NetworkError does NOT carry an HTTP status', () => {
    const err = new NetworkError();

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(isNetworkError(err)).toBe(true);
    expect(isApiError(err)).toBe(false);
  });

  it('CorsError is a distinguishable subtype but still instanceof NetworkError', () => {
    const err = new CorsError();

    expect(err).toBeInstanceOf(NetworkError);
    expect(err.name).toBe('CorsError');
    expect(isNetworkError(err)).toBe(true);
    expect(isApiError(err)).toBe(false);
  });

  it('preserves the original thrown cause on NetworkError', () => {
    const cause = new TypeError('Failed to fetch');
    const err = new NetworkError(undefined, { cause });

    expect(err.cause).toBe(cause);
  });
});
