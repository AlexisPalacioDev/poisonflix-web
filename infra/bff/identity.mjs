// Identity operations against Jellyfin (source of truth for accounts) and
// Jellyseerr (authorization). These are the ONLY calls that use the Jellyfin
// admin token and the Jellyseerr API key, and they never leave the BFF.
//
// Jellyfin reachability note: the BFF joins the jellyfin-server_default docker
// network so it can reach `jellyfin-ts:8096` by name (jellyfin runs in that
// container's network namespace) — robust against host LAN IP changes.

const {
  JELLYFIN_URL = 'http://jellyfin-ts:8096',
  JELLYFIN_API_KEY = '',
  JELLYSEERR_URL = 'http://jellyseerr:5055',
  JELLYSEERR_API_KEY = '',
} = process.env;

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

/** @returns {string | null} an error message, or null if valid. */
export function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.';
  }
  return null;
}

/** @returns {string | null} an error message, or null if valid. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password.length > MAX_PASSWORD) {
    return `Password must be at most ${MAX_PASSWORD} characters.`;
  }
  return null;
}

async function jellyfin(path, init = {}) {
  const res = await fetch(`${JELLYFIN_URL}${path}`, {
    ...init,
    headers: {
      'X-Emby-Token': JELLYFIN_API_KEY,
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  return res;
}

/** Case-insensitive existence check against the live Jellyfin user list. */
export async function userExists(username) {
  const res = await jellyfin('/Users');
  if (!res.ok) throw new Error(`jellyfin /Users -> ${res.status}`);
  const users = await res.json();
  const target = username.toLowerCase();
  return users.some((u) => String(u.Name).toLowerCase() === target);
}

/** Minimal user list for the admin reset UI. */
export async function listUsers() {
  const res = await jellyfin('/Users');
  if (!res.ok) throw new Error(`jellyfin /Users -> ${res.status}`);
  const users = await res.json();
  return users.map((u) => ({
    id: u.Id,
    name: u.Name,
    isAdmin: Boolean(u.Policy?.IsAdministrator),
    hasPassword: Boolean(u.HasPassword),
    lastActivityDate: u.LastActivityDate ?? null,
  }));
}

/**
 * Create a Jellyfin user and set its password. /Users/New does NOT persist the
 * password on this Jellyfin version, so we set it in a second call. Returns the
 * new user's id.
 */
export async function createUser(username, password) {
  const created = await jellyfin('/Users/New', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Name: username }),
  });
  if (created.status === 400) {
    // Jellyfin rejects duplicates / invalid names with 400.
    throw Object.assign(new Error('username unavailable'), { code: 'USERNAME_TAKEN' });
  }
  if (!created.ok) throw new Error(`jellyfin /Users/New -> ${created.status}`);
  const user = await created.json();
  const id = user.Id;
  await setPassword(id, password, { fresh: true });
  return id;
}

/**
 * Set/replace a user's password with the admin token.
 * `fresh` true: the account has no password yet (CurrentPw empty is accepted).
 * `fresh` false (admin reset of an existing account): clear it first via
 * ResetPassword, then set the new one — CurrentPw is unknown to the admin.
 */
export async function setPassword(id, newPassword, { fresh = false } = {}) {
  if (!fresh) {
    const reset = await jellyfin(`/Users/${id}/Password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ResetPassword: true }),
    });
    if (!reset.ok && reset.status !== 204) {
      throw new Error(`jellyfin reset password -> ${reset.status}`);
    }
  }
  const res = await jellyfin(`/Users/${id}/Password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ CurrentPw: '', NewPw: newPassword }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`jellyfin set password -> ${res.status}`);
  }
}

export async function deleteUser(id) {
  const res = await jellyfin(`/Users/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`jellyfin delete user -> ${res.status}`);
}

/** Import a freshly created Jellyfin user into Jellyseerr so login works. */
export async function importToJellyseerr(jellyfinUserId) {
  const res = await fetch(`${JELLYSEERR_URL}/api/v1/user/import-from-jellyfin`, {
    method: 'POST',
    headers: { 'X-Api-Key': JELLYSEERR_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ jellyfinUserIds: [jellyfinUserId] }),
  });
  if (!res.ok) throw new Error(`jellyseerr import -> ${res.status}`);
}
