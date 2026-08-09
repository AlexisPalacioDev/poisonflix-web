import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../auth/AuthContext";
import { clearSession, setSession } from "../../lib/session/store";
import { getRadio } from "../../api/music";
import { MusicPlayerProvider } from "./MusicPlayerProvider";
import { useMusicPlayer, type MusicTrack } from "./musicPlayerCore";
import { useAutoplayRadio } from "./useAutoplayRadio";

// `warmMusicTrack` is stubbed too, not because this suite exercises it (that's
// `MusicPlayerProvider.warm.test.tsx`'s job) — the provider now imports it
// unconditionally and calls it once autoplay's radio pull queues a preview
// track with a next-track slot, so leaving it out here throws mid-effect.
vi.mock("../../api/music", () => ({ getRadio: vi.fn(), warmMusicTrack: vi.fn() }));
const mockedGetRadio = vi.mocked(getRadio);

// A library track: it knows its Jellyfin item but not the videoId it came from,
// so the radio has to be seeded by itemId (the worker reverses it).
const LIBRARY_TRACK: MusicTrack = {
  itemId: "aud-1",
  title: "Library Song",
  artist: "The Band",
  coverUrl: null,
};

// A search / radio track carries its own videoId, the better seed.
const SEARCH_TRACK: MusicTrack = {
  itemId: "vid-1",
  title: "Search Song",
  artist: "The Band",
  coverUrl: null,
  videoId: "vid-1",
  streamUrl: "/bff/music/stream?videoId=vid-1",
};

function relatedSong(videoId: string, title: string) {
  return {
    type: "song",
    videoId,
    title,
    artist: "Someone",
    artists: ["Someone"],
    album: null,
    durationSeconds: null,
    thumbnailUrl: null,
    source: "ytmusic",
    downloaded: false,
    jellyfinItemId: null,
  };
}

function Harness({ track }: { track: MusicTrack }) {
  useAutoplayRadio();
  const { playNow, queue, setRepeat, setAutoplay } = useMusicPlayer();
  return (
    <div>
      <button type="button" onClick={() => playNow([track])}>
        play
      </button>
      <button type="button" onClick={() => setRepeat("all")}>
        repeat all
      </button>
      <button type="button" onClick={() => setAutoplay(false)}>
        autoplay off
      </button>
      <ul>
        {queue.map((t, i) => (
          <li key={`${t.itemId}-${i}`}>{t.title}</li>
        ))}
      </ul>
    </div>
  );
}

function renderHarness(track: MusicTrack) {
  setSession({
    jellyfinToken: "tok-1",
    jellyfinUserId: "user-1",
    jellyseerrCookiePresent: true,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MusicPlayerProvider>
          <Harness track={track} />
        </MusicPlayerProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("useAutoplayRadio", () => {
  beforeEach(() => {
    mockedGetRadio.mockResolvedValue([
      relatedSong("vid-2", "Related One"),
    ] as never);
  });

  afterEach(() => {
    clearSession();
    localStorage.clear();
    mockedGetRadio.mockReset();
  });

  it("extends a library queue that has no next track, seeding by itemId", async () => {
    renderHarness(LIBRARY_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    await waitFor(() =>
      expect(mockedGetRadio).toHaveBeenCalledWith({ itemId: "aud-1" }, 15),
    );
    // The point of the whole feature: the queue grew before the track ended.
    expect(await screen.findByText("Related One")).toBeInTheDocument();
  });

  it("prefers the videoId a search hit already carries", async () => {
    renderHarness(SEARCH_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    await waitFor(() =>
      expect(mockedGetRadio).toHaveBeenCalledWith({ videoId: "vid-1" }, 15),
    );
  });

  it("pulls once per tail track, not once per state tick", async () => {
    renderHarness(LIBRARY_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    await waitFor(() => expect(mockedGetRadio).toHaveBeenCalledTimes(1));
    // The queue now has a next track, so the effect has nothing left to do
    // however many times the player's context value is rebuilt.
    expect(await screen.findByText("Related One")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedGetRadio).toHaveBeenCalledTimes(1);
  });

  it("gives up on a track whose radio comes back empty instead of retrying forever", async () => {
    mockedGetRadio.mockResolvedValue([] as never);
    renderHarness(LIBRARY_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    await waitFor(() => expect(mockedGetRadio).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedGetRadio).toHaveBeenCalledTimes(1);
  });

  it("re-arms after a successful pull, so replaying the track radios again", async () => {
    renderHarness(LIBRARY_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await waitFor(() => expect(mockedGetRadio).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Related One")).toBeInTheDocument();

    // Playing it again rebuilds the queue as a single track — without re-arming
    // the guard this second queue would dead-end in silence.
    fireEvent.click(screen.getByRole("button", { name: "play" }));
    await waitFor(() => expect(mockedGetRadio).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Related One")).toBeInTheDocument();
  });

  it("stays out of the way when repeat is on — that queue never falls silent", async () => {
    renderHarness(LIBRARY_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "repeat all" }));
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedGetRadio).not.toHaveBeenCalled();
  });

  it("does nothing once the user switches autoplay off", async () => {
    renderHarness(LIBRARY_TRACK);
    fireEvent.click(screen.getByRole("button", { name: "autoplay off" }));
    fireEvent.click(screen.getByRole("button", { name: "play" }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockedGetRadio).not.toHaveBeenCalled();
  });
});
