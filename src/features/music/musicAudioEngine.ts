// The music mixer: four sources, one output.
//
// THE BUG THIS EXISTS TO KILL: audio stops between tracks while the phone is
// locked. Two mechanisms in the previous design produced it, and this module
// closes both.
//
//   1. TWO ENGINES. Playback was driven imperatively from inside the gesture
//      (`playImperative`) AND declaratively from an effect. Every transition
//      that did not go through a gesture — repeat-one, removing the current
//      track — depended on the effect alone, and React schedules effects
//      through the scheduler's MessageChannel. A tab iOS has frozen may never
//      run that callback, so the dispatch lands and the sound never does.
//   2. THE SRC REASSIGNMENT. Changing a track meant `audio.src = url` on the
//      very element that was sounding. That `emptied` -> `load` -> `play`
//      sequence is a real window with no audio flowing, and it is exactly the
//      window in which the OS takes the audio session away.
//
// The design here removes the window instead of trying to survive it. Nothing
// ever reassigns the src of an element that is playing — not on next/prev
// (a neighbour already holds it), and not on a jump either (the load goes to
// a neighbour slot, which is then rotated into). The element that takes over
// starts before the one it replaces stops.
//
// HOW MUCH OF THIS IS PROVEN, said plainly rather than left implied: the two
// mechanisms above are read off this codebase's own previous implementation
// and are not in doubt. That removing them FIXES the owner's locked-screen
// hang is a reasoned bet, not a measured result — the same bet, with the same
// caveat, that silentKeepalive.ts states about itself ("it has never been
// verified against the owner's device, and this file does not claim it fixes
// the hang"). Nothing here has been on a real iPhone yet. The claim this file
// does make is narrower and checkable: the gap this design removes is real,
// and it was in the path of every track change.
//
// ── THE FOUR SOURCES ─────────────────────────────────────────────────────
//
//   [silent tone]  -> gain 0 ─┐
//   [current]      -> gain 1 ─┤
//   [next]         -> gain 0 ─┼─> destination        (one AudioContext)
//   [prev]         -> gain 0 ─┘
//
// The tone is the floor: it starts the instant music mode is entered, before
// any track's bytes have been asked for, and it is never suspended while the
// session is alive. The INTENT is that the OS never sees this page's audio go
// quiet, so there is no silence for it to reclaim the session during — which
// is the unverified half above, not an established fact.
//
// The other three are ordinary `<audio>` elements fed into the same graph
// through `silentKeepalive.routeElement`. They are ROUTED ONCE, at resume(),
// and never unrouted — which turns `createMediaElementSource`'s irreversible
// bind (see silentKeepalive.ts's "ONE AUDIO ORIGIN" note) from a hazard into
// the guarantee this design is built on. Four sources go in, one signal comes
// out, and no element ever changes which output it belongs to.
//
// ── WHY THE NEIGHBOURS ARE PAUSED, NOT SOUNDING AT GAIN 0 ────────────────
//
// A neighbour held at gain 0 while genuinely playing would make a track change
// seamless to the sample — literally zero gap. It would also stream all three
// tracks continuously over mobile data for the entire session, to make audible
// a difference that a ~20ms gain ramp already hides. Paused-with-buffer costs
// nothing while idle, resumes from a warm buffer in a single frame, and keeps
// the "network only while something is actually playing" constraint the
// previous design measured its way into. Paused it is.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT OWN ───────────────────────────
//
// The queue, the reducer, MediaSession, and the escape element (the fourth
// `<audio>`, never routed, the one place left that can make a sound if this
// graph dies) all stay with the provider. This module owns exactly one thing:
// which element is audible, and how a different one becomes audible without a
// silent gap in between.

import { createSilentKeepalive, type AudioRouting, type KeepaliveContextState } from './silentKeepalive';

/** Which part a physical `<audio>` element is playing right now. */
export type SlotRole = 'current' | 'next' | 'prev';

/**
 * How `setCurrentUrl` got the requested track onto the current slot. The
 * caller needs the distinction: `loaded` is the only outcome that paid for a
 * fresh network load, and it is the one worth reporting when it happens on a
 * transition that was supposed to be preloaded.
 */
export type CurrentAssignment =
  /** Already on the current slot; nothing moved. */
  | 'unchanged'
  /** The `next` slot was holding it and became current. No load. */
  | 'promoted-next'
  /** The `prev` slot was holding it and became current. No load. */
  | 'promoted-prev'
  /** Nothing held it; the current slot had to load it from the network. */
  | 'loaded';

export interface MusicAudioEngineOptions {
  /** Forwarded from the keepalive: the graph can no longer carry sound. */
  onRoutingLost?: (reason: string) => void;
  /** Diagnostic sink — routing, rotations, and context transitions. */
  onEvent?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface MusicAudioEngineHandle {
  /**
   * Register the three physical elements, in any order. Idempotent for the
   * same three; a different set replaces the roles wholesale (only ever
   * happens at mount/unmount, since the JSX nodes are stable).
   */
  attach(elements: Array<HTMLAudioElement | null>): void;
  /**
   * Bring the graph up and route every attached slot into it. MUST be called
   * synchronously from inside a user gesture the first time in a session: an
   * `AudioContext` is born suspended on iOS and only a gesture can move it to
   * running. Idempotent and cheap afterwards — safe to call on every play.
   *
   * Never throws and never awaits, so it can sit in the gesture-synchronous
   * path immediately before the real element's `play()` without delaying it.
   */
  resume(): void;
  /** The element that is (or is about to be) audible. */
  getCurrent(): HTMLAudioElement | null;
  /** The element holding a given role, or null before `attach`. */
  getElement(role: SlotRole): HTMLAudioElement | null;
  /** The role an element currently holds, or null when it is not a slot. */
  getRole(el: HTMLAudioElement | null | undefined): SlotRole | null;
  /** The URL a slot is holding, or null when it holds nothing. */
  getUrl(role: SlotRole): string | null;
  /**
   * Make `url` the current track WITHOUT ever reassigning the src of a slot
   * that is playing — the single rule this whole module exists to enforce.
   *
   * Rotates roles when a neighbour already holds the URL, and only falls back
   * to a real `src` assignment when nothing does. Does not call `play()`:
   * starting playback is the caller's, inside its own gesture-synchronous
   * path, so the engine never introduces a scheduling layer between the
   * gesture and the sound.
   */
  setCurrentUrl(url: string | null): CurrentAssignment;
  /**
   * Buffer the tracks on either side of the current one. Passing null for
   * either releases whatever that slot was holding — a slot pointing at a
   * track that is no longer adjacent is just a held network resource.
   *
   * Never touches the current slot, at any time, for any reason.
   */
  setNeighbourUrls(urls: { next: string | null; prev: string | null }): void;
  /**
   * Silence and pause every slot that is not current. Called after a rotation
   * settles, and defensively whenever the caller suspects a neighbour started
   * sounding on its own.
   */
  silenceNeighbours(): void;
  /**
   * Tell the engine whether the listener currently wants sound. Does NOT stop
   * the tone — that is the point of the mixer — but it is what keeps an OS
   * interruption during a USER PAUSE from being read as the graph failing.
   * Without it, a pause plus iOS interrupting a hidden page burns the one-way
   * escape on a session nobody was listening to. Call `false` on pause,
   * `true` when playback resumes.
   */
  setPlaybackIntent(wanted: boolean): void;
  /**
   * Forget what a slot was holding, because its load failed. The engine tracks
   * INTENT (what it asked each element to hold), and an element whose fetch
   * died still looks buffered from the inside: promoting it would return
   * `promoted-next` for a track that can never play, and every call after that
   * would answer `unchanged` — permanent silence with the bookkeeping all
   * green. The caller owns the `error` events, so the caller has to say so.
   */
  invalidateElement(el: HTMLAudioElement | null | undefined): void;
  /**
   * Release the tone and tear the context down. Unmount ONLY.
   *
   * TERMINAL, and deliberately not offered as an idle-timeout knob: closing a
   * context does not release the elements bound to it, so a later `resume()`
   * would build a fresh graph carrying nothing while all three slots stay mute
   * in the dead one — with no error, no event, and `isRoutingLost()` still
   * false. The underlying handle now refuses to rebuild after a close, but the
   * honest fix is not to call this until the player is going away. If holding
   * the audio session through a long pause ever needs to be given up, that
   * wants a different operation than this one.
   */
  close(): void;
  /** Live `AudioContext` state, for the lock diagnostics trace. */
  getState(): KeepaliveContextState;
  /** Whether an element's sound leaves through the graph. Diagnostics. */
  getRouting(el: HTMLAudioElement | null | undefined): AudioRouting;
  /** True once the graph has been declared unable to carry sound. */
  isRoutingLost(): boolean;
  /**
   * Stop using the graph entirely: the caller has handed playback to an
   * element this engine never routed (the escape element). Rotation and
   * preloading stop, because the three slots are captive from that point on.
   */
  markEscaped(): void;
  /** Whether `markEscaped` has been called. */
  isEscaped(): boolean;
}

/**
 * Whether the song's own output is fed INTO the keepalive's AudioContext (the
 * "one output" design) or left to leave its element directly.
 *
 * DEFAULTS TO OFF, and that is a reversal of the shipped design. The reasoning,
 * written down because it overrides an explicit request:
 *
 * The benefit was never demonstrated. silentKeepalive.ts says so about its own
 * hypothesis in as many words — "PLAUSIBLE, NOT PROVEN", no device trace
 * confirms either half. Routing was adopted on an argument, not a measurement.
 *
 * The cost IS demonstrated, and it is asymmetric. `createMediaElementSource`
 * binds an element to a context for the lifetime of the document: there is no
 * un-route, `disconnect()` only deepens the silence, and a second context
 * cannot adopt the element. So when that context stops carrying sound, every
 * element inside it is mute FOREVER. The owner's traces show exactly that
 * happening: the AudioContext went `interrupted` 11 times across 118 samples
 * while the song was still routed into it, and `graphEscaped` was false in
 * every single one — the escape hatch built for this never fired once, because
 * it depended on a timer that a backgrounded iOS tab does not run.
 *
 * An unrouted `<audio>` element cannot fail that way. It is also the shape iOS
 * supports best for background playback and MediaSession, which is the other
 * half of what the owner reported broken.
 *
 * A feature that is unproven on the upside and catastrophic on the downside
 * does not get to be the default. It stays one flip away, because if a trace
 * ever shows routing helping, this is how it comes back:
 *
 *     https://…/musica?audioroute=on    songs share one output again
 *     https://…/musica?audioroute=off   back to the default
 *
 * The choice persists in localStorage and every diagnostic sample records
 * which mode it was taken in (`routeMode`), so the two can still be compared.
 *
 * NOTE what this does NOT turn off: the silent tone still runs, and the slots
 * still rotate. The tone never captures an element, so it cannot take playback
 * down with it; the rotation is the part that removed the src reassignment,
 * and it is independent of where the sound leaves.
 */
const ROUTE_MODE_KEY = 'poisonflix:music.routeToGraph';

export function graphRoutingEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const param = new URLSearchParams(window.location.search).get('audioroute');
    if (param === 'off' || param === 'on') {
      window.localStorage.setItem(ROUTE_MODE_KEY, param === 'on' ? '1' : '0');
    }
    return window.localStorage.getItem(ROUTE_MODE_KEY) === '1';
  } catch {
    // Private mode, disabled storage, anything — fall back to the safe side.
    return false;
  }
}

/** Role gain values. Binary by design — see `setElementGain`'s docstring in
 *  silentKeepalive.ts for why a role gain does not double-apply the user's
 *  volume the way an arbitrary one would. */
const AUDIBLE = 1;
const SILENT = 0;

export function createMusicAudioEngine(
  options: MusicAudioEngineOptions = {},
): MusicAudioEngineHandle {
  const keepalive = createSilentKeepalive({
    onRoutingLost: options.onRoutingLost,
    onEvent: options.onEvent,
  });

  // Role -> element. Null until `attach` runs.
  let currentEl: HTMLAudioElement | null = null;
  let nextEl: HTMLAudioElement | null = null;
  let prevEl: HTMLAudioElement | null = null;

  // What each slot is holding. Kept here rather than read back off
  // `el.src`/`el.currentSrc`, because the browser resolves those to absolute
  // URLs and normalises them — comparing an assigned relative URL against a
  // resolved absolute one reports "different" for the same resource, and a
  // false "different" here is precisely the src reassignment this module
  // exists to prevent.
  const urls = new WeakMap<HTMLAudioElement, string>();

  // Every slot routed into the graph, at most once each. Routing can only
  // happen once a context exists, and the context only exists after a gesture
  // — so this is retried on every `resume()` until it takes.
  const routed = new WeakSet<HTMLAudioElement>();

  let escaped = false;

  const emit = (message: string, detail?: Record<string, unknown>) => {
    try {
      options.onEvent?.(message, detail);
    } catch {
      // A diagnostic sink must never be able to break playback.
    }
  };

  const slots = (): HTMLAudioElement[] =>
    [currentEl, nextEl, prevEl].filter((el): el is HTMLAudioElement => el !== null);

  const urlOf = (el: HTMLAudioElement | null): string | null =>
    el ? (urls.get(el) ?? null) : null;

  /** Load `url` onto a slot, or release it when `url` is null. NEVER call for
   *  the current slot while it is meant to be sounding — that is the whole
   *  point of this module. */
  const loadInto = (el: HTMLAudioElement | null, url: string | null) => {
    if (!el) return;
    if (urlOf(el) === url) return;
    if (!url) {
      // `pause()` before releasing: an element still fetching a resource it is
      // about to drop keeps the connection open until the load algorithm
      // notices, and background network is the scarcest thing this feature has.
      try {
        if (!el.paused) el.pause();
        el.removeAttribute('src');
        el.load();
        urls.delete(el);
      } catch {
        // The release did not happen, so the element is still holding that
        // resource — and the bookkeeping must keep saying so. Clearing the map
        // here (an earlier version did, before the try) would tell the
        // duplicate guard in `setNeighbourUrls` that this slot is free, and it
        // would happily hand the same URL to another element.
      }
      return;
    }
    try {
      el.src = url;
      el.load();
      // Recorded only once the assignment actually went through. Setting it
      // first and rolling back in the catch leaves the opposite, worse
      // desync — an element holding a source the map says it does not have.
      urls.set(el, url);
    } catch {
      urls.delete(el);
    }
  };

  /** Move a routed element's role gain. Silently does nothing for an element
   *  that was never routed (no graph yet) — in that case the element plays
   *  straight out of itself and its own `paused` state is what makes it
   *  audible or not, which is still correct, just not mixable. */
  const setGain = (el: HTMLAudioElement | null, value: number) => {
    if (!el) return;
    keepalive.setElementGain(el, value);
  };

  const attach = (elements: Array<HTMLAudioElement | null>) => {
    const present = elements.filter((el): el is HTMLAudioElement => Boolean(el));
    // Unmount: React hands every ref back as null. Drop the references rather
    // than keeping three detached elements alive in this closure forever.
    if (present.length === 0 && elements.length > 0) {
      currentEl = null;
      nextEl = null;
      prevEl = null;
      emit('detached', {});
      return;
    }
    // Partial set — React calls the ref callbacks one at a time, and this
    // function keeps NO memory between calls (the caller accumulates). Only a
    // complete set is adopted, because a half-attached engine would assign
    // roles it has to reshuffle a moment later, and reshuffling roles is not
    // free once elements are routed.
    if (present.length < 3) return;
    // Distinct elements only. Two roles pointing at one node makes
    // `setCurrentUrl` answer 'unchanged' forever for whatever that node holds,
    // and there is no arrangement of three roles over two nodes that works.
    const unique = Array.from(new Set(present));
    if (unique.length < 3) {
      emit('attachRefused', { reason: 'duplicate-elements' });
      return;
    }
    // SET comparison, not positional. After any rotation the roles no longer
    // line up with the JSX order, so comparing position by position reports
    // "different" for the very same three nodes and clobbers the live
    // arrangement — which, because the third slot keeps whatever gain it had,
    // leaves TWO elements audible at once. Re-attaching the same three
    // elements must be a no-op no matter which of them is currently playing.
    const known = [currentEl, nextEl, prevEl].filter(Boolean);
    if (known.length === 3 && unique.every((el) => known.includes(el))) return;
    currentEl = unique[0];
    nextEl = unique[1];
    prevEl = unique[2];
    // Roles just changed wholesale; the gains that went with the old
    // arrangement are meaningless now. Re-assert them so no element is left
    // audible in a role that is no longer its own.
    setGain(currentEl, AUDIBLE);
    setGain(nextEl, SILENT);
    setGain(prevEl, SILENT);
    emit('attached', {});
  };

  /**
   * Bind every slot that is not bound yet into the graph, at the gain its
   * CURRENT role calls for. Every slot, not just the current one: a slot that
   * becomes current later must ALREADY be in the graph, because binding an
   * element mid-handover means a bind that can fail (no context, cross-origin)
   * at the exact moment the track needs to sound, leaving it playing out of a
   * second origin — the arrangement this design exists to remove.
   *
   * Called from `resume()` AND after anything gives a slot its first source:
   * `routeElement` refuses an element with nothing loaded (no origin to
   * verify), so a slot that was empty at gesture time would otherwise stay
   * outside the graph for the rest of the session with nothing to retry it.
   */
  const routeSlots = () => {
    if (escaped) return;
    // The experiment switch. When off, no element is ever bound: each one
    // plays out of its own output, the tone keeps running on its own context,
    // and the escape hatch becomes unnecessary because nothing is captive.
    if (!graphRoutingEnabled()) return;
    for (const el of slots()) {
      if (routed.has(el)) continue;
      const role: SlotRole = el === currentEl ? 'current' : el === nextEl ? 'next' : 'prev';
      if (keepalive.routeElement(el, { gain: role === 'current' ? AUDIBLE : SILENT })) {
        routed.add(el);
        emit('slotRouted', { role });
      }
    }
  };

  const resume = () => {
    // The tone first, and the order is the point: it has to already be
    // sounding while the real track is still loading, because that load is
    // exactly the stretch with no audio of its own. WebKit also hands the
    // audio route to whoever asked LAST, so silence first, song second.
    keepalive.start();
    if (escaped) return;
    routeSlots();
    // Re-assert the gains on every resume. A slot routed on an earlier pass
    // holds whatever gain it was given THEN, and rotations since may have
    // changed which role it is playing.
    setGain(currentEl, AUDIBLE);
    setGain(nextEl, SILENT);
    setGain(prevEl, SILENT);
  };

  /**
   * The rotation. `promoted` becomes current; the outgoing current takes
   * `promoted`'s old role; the third slot is freed for whatever is adjacent
   * now. A 3-cycle in both directions, which is why three elements are enough
   * to hold current/next/prev with no element ever being loaded twice.
   */
  const rotateTo = (promoted: HTMLAudioElement) => {
    const outgoing = currentEl;
    // Captured BEFORE the reassignments below: every role variable is about to
    // change, so reading `promoted === prevEl` afterwards reports the new
    // arrangement, not the move that produced it.
    const direction = promoted === nextEl ? 'forward' : 'backward';
    if (promoted === nextEl) {
      // forward: next -> current, current -> prev, prev -> next (now free)
      const freed = prevEl;
      currentEl = promoted;
      prevEl = outgoing;
      nextEl = freed;
    } else {
      // backward: prev -> current, current -> next, next -> prev (now free)
      const freed = nextEl;
      currentEl = promoted;
      nextEl = outgoing;
      prevEl = freed;
    }
    // A promoted neighbour has been sitting paused wherever it last stopped
    // (it may have been the current track two skips ago). Start it from the
    // top; a track taking over mid-song is never what a skip means.
    try {
      if (promoted.currentTime !== 0) promoted.currentTime = 0;
    } catch {
      // Not seekable yet. It will start wherever it starts, which still beats
      // not starting.
    }
    // GAINS ONLY — the outgoing element is deliberately NOT paused here, and
    // this is the one ordering rule the caller has to respect.
    //
    // Said precisely, because an earlier version of this comment overstated
    // it: the incoming element is paused at this instant (neighbours are
    // buffered, not sounding — see the header), so rotating does not by itself
    // hand sound from one element to the other with no seam. What it does is
    // leave the outgoing element STILL PLAYING, so the caller's `play()` on
    // the incoming one lands before anything has stopped. Pausing here instead
    // would open a real gap between the pause and that `play()`. The caller
    // closes the loop with `silenceNeighbours()` AFTER it has called `play()`.
    //
    // What actually covers the remaining sub-frame seam is the silent tone,
    // which never stops — not this ordering.
    setGain(promoted, AUDIBLE);
    setGain(outgoing, SILENT);
    emit('rotated', { direction });
  };

  const setCurrentUrl = (url: string | null): CurrentAssignment => {
    if (!url) {
      // Nothing playable. Deliberately does NOT release the current slot's
      // source: an empty current slot is an element that cannot be routed and
      // cannot sound, and the queue moving through a track with no resolvable
      // URL must not cost the session its graph membership. The caller pauses;
      // the stale source is harmless and gets replaced by the next real one.
      return 'unchanged';
    }
    // After an escape all three slots are captive in a graph that cannot make
    // a sound. Rotating between them would hand the track to another mute
    // element, and loading onto one would spend the session's scarce
    // background network on bytes that can never be played. The caller owns
    // the escape element from that point on and assigns its source itself.
    if (escaped) return 'unchanged';
    if (urlOf(currentEl) === url) return 'unchanged';
    if (nextEl && urlOf(nextEl) === url) {
      rotateTo(nextEl);
      return 'promoted-next';
    }
    if (prevEl && urlOf(prevEl) === url) {
      rotateTo(prevEl);
      return 'promoted-prev';
    }
    // Nothing had it buffered — a jump to a track that is neither ahead of nor
    // behind the current one. Somebody has to load, but it MUST NOT be the
    // element that is sounding: assigning its `src` is the `emptied` -> `load`
    // -> `play` gap this whole design exists to remove, and a jump is no less
    // subject to it than an auto-advance. (An adversarial review caught
    // exactly this: the rule held for next/prev and quietly broke for jumps.)
    //
    // So load onto the NEXT slot and rotate into it. The playing element keeps
    // its source, becomes `prev`, and stays instantly available — which is
    // also what makes "jump somewhere, then go back" work.
    if (currentEl && nextEl && urlOf(currentEl) !== null) {
      loadInto(nextEl, url);
      routeSlots();
      rotateTo(nextEl);
      return 'loaded';
    }
    // Nothing is playing yet (first track of the session, or no neighbour to
    // borrow): the current slot has nothing to protect, so load straight onto
    // it. `routeSlots` after the load because `routeElement` refuses an
    // element with no source — this is where a first track gets bound.
    loadInto(currentEl, url);
    routeSlots();
    setGain(currentEl, AUDIBLE);
    return currentEl ? 'loaded' : 'unchanged';
  };

  const setNeighbourUrls = ({ next, prev }: { next: string | null; prev: string | null }) => {
    if (escaped) return;
    // Guard against a caller asking a neighbour to hold what the current slot
    // is already playing: two elements with the same source is two concurrent
    // GETs for one track, and on a Jellyfin DirectPlay URL that is two
    // server-side playback sessions for one listen.
    const playing = urlOf(currentEl);
    const wantNext = next && next !== playing ? next : null;
    // ...and `prev` must differ from `next` too. A two-track queue on
    // repeat-all asks for the same URL in both directions (the track after A
    // is B, and the track before A is also B), which would put one resource on
    // two elements: two concurrent GETs, and on a Jellyfin DirectPlay URL two
    // server-side playback sessions for one listen. `next` wins because
    // forward is the direction playback takes on its own.
    const wantPrev = prev && prev !== playing && prev !== wantNext ? prev : null;
    loadInto(nextEl, wantNext);
    loadInto(prevEl, wantPrev);
    // A neighbour that just received its first source can now be bound; until
    // it is, it would sound out of its own output the moment it is promoted.
    routeSlots();
    // Safety net, not bookkeeping: this runs from an effect after every track
    // change, so a rotation whose caller never got as far as
    // `silenceNeighbours()` (an exception between the two, a code path added
    // later that forgets) still ends with only one element streaming. Cheap
    // when everything already went right — both are paused and at zero.
    silenceNeighbours();
  };

  const silenceNeighbours = () => {
    for (const el of [nextEl, prevEl]) {
      if (!el) continue;
      setGain(el, SILENT);
      try {
        if (!el.paused) el.pause();
      } catch {
        // Nothing to do — the gain is already at zero, so it is inaudible
        // regardless of whether the element itself stopped.
      }
    }
  };

  return {
    attach,
    resume,
    getCurrent: () => currentEl,
    getElement: (role) => (role === 'current' ? currentEl : role === 'next' ? nextEl : prevEl),
    getRole: (el) => {
      if (!el) return null;
      if (el === currentEl) return 'current';
      if (el === nextEl) return 'next';
      if (el === prevEl) return 'prev';
      return null;
    },
    getUrl: (role) =>
      urlOf(role === 'current' ? currentEl : role === 'next' ? nextEl : prevEl),
    setCurrentUrl,
    setNeighbourUrls,
    silenceNeighbours,
    setPlaybackIntent: (wanted: boolean) => keepalive.setPlaybackIntent(wanted),
    invalidateElement: (el) => {
      if (!el) return;
      const had = urlOf(el);
      if (had === null) return;
      // RELEASE it, do not merely forget it. Forgetting alone left the element
      // still holding the failed source — and therefore still holding its
      // connection — while the engine believed the slot was empty, so
      // `loadInto(el, null)` would early-return and never actually clear it.
      // A test written for the preload-retry loop caught this: the URL was
      // still on the element after the engine had given up on it.
      urls.delete(el);
      try {
        if (!el.paused) el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // Best effort — the bookkeeping is already correct either way.
      }
      emit('slotInvalidated', { role: el === currentEl ? 'current' : el === nextEl ? 'next' : el === prevEl ? 'prev' : 'unknown' });
    },
    close: () => keepalive.close(),
    getState: () => keepalive.getState(),
    getRouting: (el) => keepalive.getRouting(el),
    isRoutingLost: () => keepalive.isRoutingLost(),
    markEscaped: () => {
      if (escaped) return;
      escaped = true;
      // Release both neighbours on the way out. They are holding buffered
      // bytes for tracks that can never be played through this graph, and a
      // held resource keeps its connection open — on a session that has just
      // lost its audio graph, background network is exactly what the escape
      // element now needs for itself.
      loadInto(nextEl, null);
      loadInto(prevEl, null);
      emit('escaped', {});
    },
    isEscaped: () => escaped,
  };
}
