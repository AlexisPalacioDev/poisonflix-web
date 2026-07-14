import { useMutation } from '@tanstack/react-query';
import { register, type RegisterParams } from '../api/bff';
import type { RegisterResponse } from '../api/schemas/bff';

// Register mutation (register spec). Thin wrapper, mirrors useCancelDownload -
// no cache to invalidate since there's no session yet when this runs.
export function useRegister() {
  return useMutation<RegisterResponse, unknown, RegisterParams>({
    mutationFn: (params) => register(params),
  });
}
