import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { usePlaybackInfo } from '../../hooks/usePlaybackInfo';
import { isApiError } from '../../lib/http/errors';
import { VideoSurface } from '../player/VideoSurface';
// The cast surface IS a player surface: same full-bleed black stage, same
// centred status card. Reusing the stylesheet keeps the two from drifting into
// two slightly different-looking players.
import '../player/player.css';
import { CAST_TOKEN_PARAM } from './castUrls';
import { useCastLoadWatchdog, type CastLoadPhase } from './useCastLoadWatchdog';
import { useCastViewer } from './useCastViewer';

// `/cast/:id` - the PUBLIC playback surface, the one a television opens.
//
// ## Why it exists
// A `capability: 'app'` device (LG over SSAP, or DIAL) is handed a URL and
// opens it in its own browser. That browser has no localStorage of ours, so
// it has no session - and `/player/:id` sits behind `RouteGuard`, which
// bounces anything without one straight to `/onboarding`. The audited result
// was a television showing the login form while this app announced
// "Reproduciendo en LG del living": a false success, the exact failure shape
// this codebase already has scars from.
//
// So this route carries its own credential, in the URL. The cost is real and
// was weighed: the token lands in the TV browser's history. What decided it is
// that the same token is ALREADY in the query string of every video URL the
// app builds (`buildDirectPlayUrl` puts it there as `api_key`, because a
// `<video>` element cannot send a header) - this page is not a new exposure,
// it is the existing one with a player around it.
//
// ## Why it is this small
// That trade only holds if the URL stays a key to ONE door. So there is no
// navigation here, no top bar, no back button, no library, no search, no
// account, and no cast button of its own. Someone holding this link can watch
// THIS video and do nothing else with it. Every control that could turn the
// token into a master key is absent on purpose, not merely unstyled - adding
// one back is a security change, not a UX tweak.
//
// ## What this surface deliberately does NOT do, and what that costs
// - No playback reporting. `usePlaybackHeartbeat` lives in `PlayerScreen` and
//   is not mounted here, so nothing watched on the television updates the
//   resume position or "Continuar viendo", and no `Sessions/Playing/Stopped`
//   is ever sent - a transcode session on the server closes on its own reaper
//   rather than when the video ends. Reporting would mean writing to the
//   library on behalf of a URL token, which is a wider key than this route is
//   meant to be; it is a real cost, accepted knowingly, not an oversight.
// - A fatal `<video>` error is terminal here: it renders a sentence and stops.
//   That is a dead end with an explanation, which is not the defect this file
//   guards against - the defect is a screen that says NOTHING. The one state
//   that could say nothing forever (a load that never finishes) is the one
//   that grew a retry button, below.
//
// ## Why it does not duplicate the player
// The whole resolution pipeline (`usePlaybackInfo` -> `resolvePlayback` ->
// `VideoSurface`) is the same one `PlayerScreen` uses. The only difference is
// where the credential comes from, which is exactly the seam
// `usePlaybackInfo`'s optional `credentials` argument opens. A copied
// `PlayerScreen` would be a second pipeline that drifts from the first the
// first time either is fixed.

/**
 * A string discriminant, not a set of booleans: this project compiles without
 * `strictNullChecks`, where TypeScript cannot narrow a union by a boolean
 * literal (see `castUrls.ts`'s `CastUrlsResult` for the same note).
 */
type SurfaceState = 'playing' | 'playbackFailed' | 'unsupported';

const MISSING_TOKEN_MESSAGE =
  'Este enlace no trae la credencial para reproducir. Volvé a enviar el video desde la app en tu teléfono.';

const REJECTED_TOKEN_MESSAGE =
  'La credencial de este enlace ya no sirve. Volvé a enviar el video desde la app en tu teléfono.';

const LOAD_FAILED_MESSAGE =
  'No se pudo cargar el video. Revisá que la TV siga conectada a la misma red que el servidor.';

/** 403/404: the token is fine and the server answered - this account simply
 *  cannot play this item, or the item is gone. Blaming the network here would
 *  send whoever is standing in front of the television to go restart a router
 *  over a permissions problem. */
const NO_ACCESS_MESSAGE =
  'Este video no está disponible para la cuenta que envió el enlace. Elegí otro desde la app en tu teléfono.';

const UNSUPPORTED_MESSAGE = 'Este video no se puede reproducir en el navegador de esta TV.';

const PLAYBACK_FAILED_MESSAGE = 'No se pudo reproducir este video.';

/**
 * The one message that replaces an unbounded "Cargando…".
 *
 * It names what happened (the server never answered) and both things that are
 * worth checking from the couch, because the two live in different places: the
 * television's own connection, and the server being up. "Error" would tell the
 * person in front of the TV nothing they can act on.
 */
const TIMEOUT_MESSAGE =
  'El servidor no respondió a tiempo. Revisá que la TV siga conectada a la red y que el servidor esté encendido, y probá de nuevo.';

const RETRY_LABEL = 'Reintentar';

/**
 * Which sentence a failed request deserves.
 *
 * Split by root cause rather than collapsed into one line, because the three
 * have nothing in common for the person standing in front of the television:
 * a stale link is fixed on the phone, a permissions/missing item is fixed by
 * choosing something else, and only the rest is worth checking the network
 * for. A catch-all "revisá la red" is a false diagnosis for two of the three,
 * which is the failure shape this whole feature exists to stop reproducing.
 */
function messageFor(error: unknown): string {
  if (!isApiError(error)) return LOAD_FAILED_MESSAGE;
  if (error.status === 401) return REJECTED_TOKEN_MESSAGE;
  if (error.status === 403 || error.status === 404) return NO_ACCESS_MESSAGE;
  return LOAD_FAILED_MESSAGE;
}

/** The terminal states render the same way: one sentence, centred, and nothing
 *  to press. A television has no keyboard and no back button worth offering,
 *  so a dead-end with an explanation beats a dead-end with a button that goes
 *  nowhere - every one of these is fixed on the phone, not here. The single
 *  state that IS fixable from the couch (see `CastRetryMessage`) is the one
 *  that gets a button. */
function CastMessage({ message }: { message: string }) {
  return (
    <main className="pf-player-screen">
      <div className="pf-player-screen__status pf-player-screen__status--error" role="alert">
        <span>{message}</span>
      </div>
    </main>
  );
}

/**
 * The one message with a way out of it.
 *
 * Reachable with a remote, which takes more than a click handler
 * (`lib/tv/spatialNavigation.ts`):
 *  - a NATIVE `<button>`, because the D-pad navigator's candidate query is a
 *    selector list of real focusable elements; a clickable `<div>` is
 *    invisible to it and to Tab both.
 *  - FOCUSED on mount. The navigator adopts the first candidate when nothing
 *    is focused, but only once an arrow key is pressed, and a remote's OK
 *    button does not move focus. Without this the first press of OK - the
 *    obvious thing to do when a screen shows one button - would do nothing at
 *    all, which is a mute screen again, one keypress deeper.
 *  - and VISIBLY focused, which is why `player.css` gives this button a plain
 *    `:focus` ring instead of leaning on global.css's `:focus-visible` one.
 *    A programmatic `.focus()` does not count as focus-visible in Chromium,
 *    and the 2018 webOS browser does not know the pseudo-class at all.
 *
 * The navigator also filters candidates by a non-zero rect. That part is
 * asserted by nothing here and CANNOT be: `getBoundingClientRect` is always
 * 0x0 in jsdom. The centred status card lays out like the sibling messages
 * this screen already ships, but "it is visible on the television" is a claim
 * for a live page, not for this suite.
 */
function CastRetryMessage({ message, onRetry }: { message: string; onRetry: () => void }) {
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return (
    <main className="pf-player-screen">
      <div className="pf-player-screen__status pf-player-screen__status--error" role="alert">
        <span>{message}</span>
        <button type="button" ref={retryRef} onClick={onRetry}>
          {RETRY_LABEL}
        </button>
      </div>
    </main>
  );
}

export function CastScreen() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  // `?? ''` only satisfies the type: a dynamic segment cannot match an empty
  // one, so `/cast/` and `/cast` fall through to the catch-all route rather
  // than arriving here without an id (checked against this router, not
  // assumed). There is deliberately no "missing item" branch below - it would
  // be a message no one can ever reach, and untested dead code that looks like
  // a handled case is worse than none.
  const itemId = id ?? '';
  // Trimmed here rather than at every use: `?token=` with nothing after it and
  // no `token=` at all are the same situation, and both must reach the same
  // explicit message instead of a blank screen or a silent 401.
  const token = (searchParams.get(CAST_TOKEN_PARAM) ?? '').trim();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [surfaceState, setSurfaceState] = useState<SurfaceState>('playing');
  const queryClient = useQueryClient();

  const viewer = useCastViewer(token);
  const viewerId = viewer.data?.Id ?? '';
  // Both hooks run on every render, before any of the early returns below -
  // React matches hook state by call order, so a render that skips them would
  // corrupt the next one.
  const playback = usePlaybackInfo(itemId, { userId: viewerId, token });

  // WHICH wait is open, computed before any early return because the watchdog
  // is a hook. `'ready'` covers every state that already has something on the
  // screen - playing, or one of the messages below - so no timer is armed
  // behind it.
  //
  // Be precise about what this does and does not buy, because the two are easy
  // to confuse: what guarantees a real diagnosis beats a generic "no respondió
  // a tiempo" is the ORDER of the returns below (the expired branch lives
  // inside `!playback.data`, after every error branch), not this phase. Even a
  // timer left running behind a playing video would change nothing on screen.
  // The phase is what keeps the BUDGETS separate - each wait measured from
  // when that wait started - plus one timer that is simply not armed when
  // nothing is being waited for.
  const loadPhase: CastLoadPhase = ((): CastLoadPhase => {
    if (!token || viewer.isError || playback.isError) return 'ready';
    if (!viewer.isSuccess) return 'viewer';
    // Answered, but with no id: its own message below, not a wait.
    if (!viewerId) return 'ready';
    return playback.data ? 'ready' : 'stream';
  })();

  const watchdog = useCastLoadWatchdog(loadPhase);

  // Starts the load over.
  //
  // NOT `refetch()`, which is a DEAD BUTTON in exactly the situation this
  // screen offers it in - caught by the test, not by reading the docs.
  // react-query only cancels an in-flight fetch when the query already holds
  // data; on a first load it hands back the promise that is still pending and
  // never calls the query function again. The whole failure here is a first
  // load that hung, so every press would have done nothing at all: a mute
  // screen with a button on it, which is worse than one without.
  //
  // `resetQueries` cancels the hung fetch, drops the query to its initial
  // state, and refetches the ACTIVE ones - a real second attempt. Unscoped
  // because on THIS route the cache holds only this screen's own queries:
  // `/cast/:id` mounts outside `AppLayout` (no music bar, no library, no
  // navigation), and none of the providers above it runs a query of its own.
  //
  // "Only its own" is not "only two": the cache also holds the playback query
  // from the FIRST render, keyed with an empty user id, which is disabled and
  // which `refetchQueries` skips for that reason. Resetting it is harmless -
  // but if this ever needs a filter, that is the entry to remember.
  const retryLoad = () => {
    // The phase may not change (a retry of the viewer lookup is still the
    // viewer lookup), so the timer is re-armed explicitly rather than relying
    // on the phase effect to notice.
    watchdog.restart();
    void queryClient.resetQueries();
  };

  if (!token) return <CastMessage message={MISSING_TOKEN_MESSAGE} />;

  if (viewer.isError) return <CastMessage message={messageFor(viewer.error)} />;

  // A viewer that answered without an id is the one shape that would otherwise
  // spin forever: `usePlaybackInfo` stays disabled without a user id, so it
  // never fails and never resolves, and the television sits on "Cargando…" for
  // the rest of the evening. Silent degradation is the defect, not the empty
  // field - so this is said out loud instead.
  //
  // Keyed on `isSuccess`, NOT on `viewer.data`, and `loadPhase` above agrees
  // with it. The fact this branch is about is that the query ANSWERED; the
  // body is what is missing from it. Keying it on the body means any falsy
  // answer skips the branch AND reads as `'ready'` above, which disarms the
  // watchdog - a spinner with nothing left behind it, the one outcome this
  // file must never produce. That shape is hard to reach today (react-query
  // rejects a query function that resolves `undefined` outright, and the
  // schema rejects a `null` body before that), so this is not a bug being
  // fixed: it is the branch being keyed on the thing it is actually about, so
  // that a change to either of those two cannot quietly reopen the hole.
  if (viewer.isSuccess && !viewerId) return <CastMessage message={LOAD_FAILED_MESSAGE} />;

  if (playback.isError) return <CastMessage message={messageFor(playback.error)} />;

  if (surfaceState === 'unsupported') return <CastMessage message={UNSUPPORTED_MESSAGE} />;
  if (surfaceState === 'playbackFailed') return <CastMessage message={PLAYBACK_FAILED_MESSAGE} />;

  if (!playback.data) {
    // The wait ran out. Before this branch existed, a television that lost the
    // network mid-handshake stayed on the line below until someone found the
    // TV browser's own reload button with a remote - the last live path to a
    // screen that says nothing, which is the failure shape this feature is
    // built around.
    if (watchdog.state === 'expired') {
      return <CastRetryMessage message={TIMEOUT_MESSAGE} onRetry={retryLoad} />;
    }

    return (
      <main className="pf-player-screen">
        <p className="pf-player-screen__status" role="status">
          Cargando…
        </p>
      </main>
    );
  }

  return (
    <main className="pf-player-screen">
      <VideoSurface
        videoRef={videoRef}
        itemId={itemId}
        source={playback.data.resolved.source}
        resumeSeconds={playback.data.resumeSeconds}
        title={playback.data.title}
        // No `onBack`: the button is then not rendered at all. There is nothing
        // behind this page - it was opened directly by a television.
        //
        // What is left is the title bar and the transport controls: play/pause,
        // seek, volume, fullscreen. Everything else is absent rather than
        // inert. Audio and subtitle switching both need a re-resolve driven
        // from a real session, episode navigation is a way to reach OTHER
        // items, and a cast button here would let the television re-broadcast -
        // so `showTrackMenus={false}` closes the one menu that would otherwise
        // still render (a dialog whose every apply handler is a no-op), and the
        // empty track lists close the rest.
        onPlay={() => {}}
        onPause={() => {}}
        onEnded={() => {}}
        onError={() => setSurfaceState('playbackFailed')}
        onUnsupported={() => setSurfaceState('unsupported')}
        audioTracks={[]}
        subtitleTracks={[]}
        selectedAudioIndex={null}
        selectedSubtitleIndex={null}
        onAudioApplied={() => {}}
        onAudioSwitchUnavailable={() => {}}
        onSubtitleApplied={() => {}}
        selectedSecondSubtitleIndex={null}
        onSecondSubtitleApplied={() => {}}
        // Passed through rather than left empty: whatever the server burned
        // into these pixels is true here too, and the surface reads this map
        // to know it.
        subtitleDeliveryMethods={playback.data.resolved.subtitleDeliveryMethods}
        onSubtitleSwitchUnavailable={() => {}}
        buildSubtitleUrl={() => ''}
        showTrackMenus={false}
        isEpisode={false}
        episodes={[]}
        currentEpisodeId={itemId}
        onSelectEpisode={() => {}}
      />
    </main>
  );
}
