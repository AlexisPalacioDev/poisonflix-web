// Stable per-browser device identifier for the `X-Emby-Authorization` header
// (`buildEmbyAuthorizationHeader`, api/jellyfin.ts). The native reference used
// `Settings.Secure.ANDROID_ID` (OnboardingViewModel.kt L82-85); there is no
// browser equivalent, so a UUID is generated once and persisted so the same
// browser always presents the same DeviceId across logins.

const DEVICE_ID_KEY = 'poisonflix:deviceId';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getOrCreateDeviceId(): string {
  if (typeof localStorage === 'undefined') return 'poisonflix-web-unknown';
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const id = generateId();
  localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}
