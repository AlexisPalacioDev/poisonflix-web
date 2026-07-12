import { authenticateByName } from '../../api/jellyfin';
import { authJellyfin } from '../../api/jellyseerr';
import type { StoredSession } from '../session/store';

// Two-phase, both-or-nothing onboarding auth, ported from
// `OnboardingViewModel.kt` L44-51/L130-142 (design.md §6, onboarding
// spec's "Both-or-nothing two-phase authentication"). Framework-free and
// network-mockable so the branch logic is directly unit-testable without a
// DOM (mirrors streamResolver.ts / libraryIndex.ts's pure-domain pattern).

export interface OnboardingCredentials {
  username: string;
  password: string;
}

export type FailedBackend = 'jellyfin' | 'jellyseerr';

/**
 * Thrown when either backend rejects auth. `failedBackend` tells the caller
 * which one to blame (spec's "One backend unreachable" scenario); the
 * original error is preserved via the standard `cause` chain so callers can
 * distinguish NetworkError/CorsError (proxy/connectivity) from
 * ApiError(401) (bad credentials) without re-parsing messages.
 */
export class OnboardingAuthError extends Error {
  readonly failedBackend: FailedBackend;

  constructor(failedBackend: FailedBackend, cause: unknown) {
    super(`Onboarding auth failed at ${failedBackend}`, { cause });
    this.name = 'OnboardingAuthError';
    this.failedBackend = failedBackend;
  }
}

/**
 * Runs Jellyfin `authenticateByName` first, then Jellyseerr `authJellyfin`.
 * Returns the session to persist ONLY when both succeed. On any failure this
 * throws before returning, so the caller never receives a partial session to
 * persist - that is what makes "discard on partial failure" automatic rather
 * than something the caller must remember to do.
 */
export async function authenticateBothBackends(
  credentials: OnboardingCredentials,
  deviceId: string,
): Promise<StoredSession> {
  let jellyfinAuth;
  try {
    jellyfinAuth = await authenticateByName({ ...credentials, deviceId });
  } catch (cause) {
    // Jellyfin failed - stop here, no Jellyseerr call, nothing persisted.
    throw new OnboardingAuthError('jellyfin', cause);
  }

  try {
    await authJellyfin(credentials);
  } catch (cause) {
    // Jellyfin succeeded but Jellyseerr failed - the Jellyfin token obtained
    // above is discarded simply by never being persisted (it lives only in
    // this function's local `jellyfinAuth` variable, which is dropped here).
    throw new OnboardingAuthError('jellyseerr', cause);
  }

  return {
    jellyfinToken: jellyfinAuth.AccessToken,
    jellyfinUserId: jellyfinAuth.User.Id,
    jellyfinServerId: jellyfinAuth.ServerId,
    // The connect.sid cookie itself lives in the browser's cookie jar
    // (design.md §5) - this is only the marker that Jellyseerr auth succeeded.
    jellyseerrCookiePresent: true,
  };
}
