import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/http/client';
import { getAdminStorage } from './bff';
import { StorageSchema } from './schemas/bff';

// Asserts the admin storage client hits the exact BFF path + validating schema,
// through the same `apiFetch('bff', ...)` seam as every other admin call (the
// BFF re-enforces admin-only server-side; the browser sends no *arr key).

vi.mock('../lib/http/client', () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

describe('getAdminStorage', () => {
  it('GETs /admin/storage with the Storage schema and returns the payload', async () => {
    const payload = { path: '/data', freeSpace: 30_000, totalSpace: 100_000 };
    mockedApiFetch.mockResolvedValueOnce(payload);

    const result = await getAdminStorage();

    expect(mockedApiFetch).toHaveBeenCalledWith('bff', '/admin/storage', { schema: StorageSchema });
    expect(result).toEqual(payload);
  });
});
