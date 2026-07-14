import { useMutation, useQuery } from '@tanstack/react-query';
import { listAdminUsers, resetUserPassword } from '../api/bff';
import { queryKeys } from './queryKeys';

// Admin screen's "Usuarios" section - list + per-user password reset. No
// cache to invalidate on reset: the reset doesn't change anything the list
// query displays (name/isAdmin/hasPassword/lastActivityDate are unaffected).

export function useAdminUsers() {
  return useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: listAdminUsers,
  });
}

export interface ResetUserPasswordParams {
  userId: string;
  newPassword: string;
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: ({ userId, newPassword }: ResetUserPasswordParams) => resetUserPassword(userId, newPassword),
  });
}
