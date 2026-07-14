import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createInvite, listInvites, revokeInvite, type CreateInviteParams } from '../api/bff';
import { queryKeys } from './queryKeys';

// Admin screen's "Invitaciones" section - list + generate + revoke. Both
// mutations invalidate the list on success so the table reflects the new
// state without a manual refetch.

export function useInvites() {
  return useQuery({
    queryKey: queryKeys.invites(),
    queryFn: listInvites,
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateInviteParams) => createInvite(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invites() });
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => revokeInvite(code),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.invites() });
    },
  });
}
