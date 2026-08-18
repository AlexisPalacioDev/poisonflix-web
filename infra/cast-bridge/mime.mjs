// One guess about what a media URL contains, shared by every adapter that has
// to declare it.
//
// It lives here because `/play` hands the SAME `mediaUrl` to whichever adapter
// the chosen device uses, and the two that must describe it — DLNA's
// `protocolInfo` and Cast's `contentType` — were describing it differently:
// DLNA looked at the extension while Cast said `video/mp4` about everything,
// including an `.m3u8` playlist. Same URL, same question, two answers.

/**
 * Renderers and receivers switch decoders on this, so a wrong guess is a black
 * screen with audio (or nothing at all for HLS). The extension is all we have —
 * the URL is served by our own BFF and nothing here can afford a HEAD round
 * trip before every play.
 */
export function guessMimeType(url) {
  const path = String(url).split('?')[0].toLowerCase();
  if (path.endsWith('.mkv')) return 'video/x-matroska';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.avi')) return 'video/x-msvideo';
  if (path.endsWith('.mov')) return 'video/quicktime';
  if (path.endsWith('.ts')) return 'video/mp2t';
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.mpd')) return 'application/dash+xml';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.m4a')) return 'audio/mp4';
  // Not a fallback so much as the honest common case: everything this house
  // streams that is not one of the above is progressive MP4.
  return 'video/mp4';
}

/** Adaptive streams are not a file being downloaded, and players treat them so. */
export function isAdaptive(mimeType) {
  return mimeType === 'application/vnd.apple.mpegurl' || mimeType === 'application/dash+xml';
}
