import { describe, expect, it } from 'vitest';
import {
  canControlTransport,
  canQueue,
  effectiveLeader,
  type Jam,
  type JamMember,
} from './jam';

// Leadership in a Jam is DERIVED from who is connected, never stored.
//
// The owner asked for three things that look like separate features: the
// leader leaving hands control to someone else, controllers being preferred
// when that happens, and the owner reclaiming the room the moment they come
// back. Storing a "current leader" would make those three separate events to
// persist, broadcast and reconcile — with a race in every one of them, and a
// wrong answer after any BFF restart.
//
// Computed from presence, all three are the same rule read at different
// moments, and a restart cannot desynchronise anything: nobody is present
// after one, which is exactly the truth.

function member(over: Partial<JamMember> & { userId: string }): JamMember {
  return {
    name: `User ${over.userId}`,
    role: 'listener',
    invitedAt: 0,
    acceptedAt: 100,
    ...over,
  };
}

function jam(over: Partial<Jam> = {}): Jam {
  return {
    id: 'jam-1',
    name: 'Ruta a la costa',
    mode: 'king',
    ownerId: 'king',
    createdAt: 0,
    members: [
      member({ userId: 'king', role: 'owner', acceptedAt: 1 }),
      member({ userId: 'ctrl', role: 'controller', acceptedAt: 2 }),
      member({ userId: 'ctrl2', role: 'controller', acceptedAt: 3 }),
      member({ userId: 'ears', role: 'listener', acceptedAt: 4 }),
    ],
    queue: [],
    current: { index: 0, positionMs: 0, isPlaying: false, at: 0 },
    seq: 0,
    ...over,
  };
}

describe('effectiveLeader', () => {
  it('is the owner whenever the owner is there', () => {
    expect(effectiveLeader(jam(), new Set(['king', 'ctrl', 'ears']))).toBe('king');
  });

  it('falls to a controller when the owner is away', () => {
    expect(effectiveLeader(jam(), new Set(['ctrl', 'ears']))).toBe('ctrl');
  });

  it('prefers the controller who joined first among several', () => {
    // The owner asked for controllers to take priority; between two of them
    // the tie-break has to be deterministic or two clients disagree about who
    // is in charge.
    expect(effectiveLeader(jam(), new Set(['ctrl2', 'ctrl']))).toBe('ctrl');
  });

  it('falls to a plain listener when no controller is there', () => {
    // "el líder se le pasa a otro integrante que lo siga" — a room with people
    // in it always has someone able to run it.
    expect(effectiveLeader(jam(), new Set(['ears']))).toBe('ears');
  });

  it('gives the room back to the owner the moment they return', () => {
    const room = jam();
    expect(effectiveLeader(room, new Set(['ctrl']))).toBe('ctrl');
    // Same jam, same stored state — only presence changed.
    expect(effectiveLeader(room, new Set(['ctrl', 'king']))).toBe('king');
  });

  it('has no leader when the room is empty', () => {
    // Not a failure state: a Jam outlives everyone leaving it, and picking a
    // leader from nobody would mean inventing one.
    expect(effectiveLeader(jam(), new Set())).toBeNull();
  });

  it('ignores someone who was invited but never accepted', () => {
    const room = jam({
      members: [
        member({ userId: 'king', role: 'owner', acceptedAt: 1 }),
        member({ userId: 'pending', role: 'controller', acceptedAt: null }),
      ],
    });
    expect(effectiveLeader(room, new Set(['pending']))).toBeNull();
  });

  it('ignores presence from someone who is not a member at all', () => {
    expect(effectiveLeader(jam(), new Set(['stranger']))).toBeNull();
  });
});

describe('canControlTransport', () => {
  it('lets the acting leader drive while the owner is away', () => {
    expect(canControlTransport(jam(), new Set(['ctrl']), 'ctrl')).toBe(true);
  });

  it('lets a granted controller drive even with the owner present', () => {
    // This is the permission the owner asked for: he can hand out control
    // without handing over the room. It is also what lets his girlfriend skip
    // a track on the motorcycle without asking him.
    expect(canControlTransport(jam(), new Set(['king', 'ctrl']), 'ctrl')).toBe(true);
  });

  it('refuses a plain listener', () => {
    expect(canControlTransport(jam(), new Set(['king', 'ears']), 'ears')).toBe(false);
  });

  it('refuses even the owner when they are not in the room', () => {
    // Transport acts on playback happening right now. Someone who is not
    // attached has no business pausing what they cannot hear.
    expect(canControlTransport(jam(), new Set(['ctrl']), 'king')).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(canControlTransport(jam(), new Set(['stranger']), 'stranger')).toBe(false);
  });
});

describe('canQueue', () => {
  it('lets any member who accepted add to the queue', () => {
    // "Cuando ya están en la Jam, ahí sí se puede ir agregando música a la
    // cola, cada uno" — the whole point of the feature.
    expect(canQueue(jam(), 'ears')).toBe(true);
  });

  it('lets a member queue from anywhere, without being attached', () => {
    // Membership outlives presence: someone at home listening to their own
    // music can still line up a track for later.
    expect(canQueue(jam(), 'ctrl')).toBe(true);
  });

  it('refuses someone who has not accepted the invitation', () => {
    const room = jam({
      members: [
        member({ userId: 'king', role: 'owner', acceptedAt: 1 }),
        member({ userId: 'pending', acceptedAt: null }),
      ],
    });
    expect(canQueue(room, 'pending')).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(canQueue(jam(), 'stranger')).toBe(false);
  });
});
