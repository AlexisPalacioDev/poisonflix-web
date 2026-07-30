import { describe, expect, it } from 'vitest';
import { MusicPlaylistBatchStatusSchema } from './music';

// Contract test against the payload the WORKER actually emits.
//
// The batch schema drifted from the worker and nothing caught it: it required
// `id` where music-worker/server.py `batch_status` sends `jobId`, and rejected
// the `unknown` state the worker reports for a job it no longer holds. Every
// poll of a playlist or album download therefore failed validation, so the card
// sat on "Descargar" with no progress and no error while the download completed
// fine server-side. The existing suite missed it because MusicScreen.test mocks
// `requestPlaylist` wholesale and never exercises the parse.
//
// The fixtures below are copied from the worker's own output shape rather than
// written to match the schema — that is the whole point. If the worker changes,
// this fails instead of the UI going quietly dead.

describe('MusicPlaylistBatchStatusSchema against the worker payload', () => {
  it('accepts jobs keyed by jobId, as the worker sends them', () => {
    const fromWorker = {
      batchId: 'b-123',
      total: 2,
      jobs: [
        { jobId: 'j-1', videoId: 'vid1', state: 'downloading' },
        { jobId: 'j-2', videoId: 'vid2', state: 'done' },
      ],
    };

    const parsed = MusicPlaylistBatchStatusSchema.parse(fromWorker);
    expect(parsed.jobs.map((j) => j.jobId)).toEqual(['j-1', 'j-2']);
  });

  it("accepts the worker's `unknown` state for a job it lost track of", () => {
    // server.py: `state = job["state"] if job else "unknown"` — a worker restart
    // drops the in-memory job map, so this is the normal post-restart response.
    const parsed = MusicPlaylistBatchStatusSchema.parse({
      batchId: 'b-9',
      total: 1,
      jobs: [{ jobId: 'j-9', videoId: null, state: 'unknown' }],
    });

    expect(parsed.jobs[0]?.state).toBe('unknown');
  });

  it('still rejects a job with no id at all', () => {
    expect(() =>
      MusicPlaylistBatchStatusSchema.parse({
        batchId: 'b-1',
        total: 1,
        jobs: [{ videoId: 'vid1', state: 'done' }],
      }),
    ).toThrow();
  });
});
