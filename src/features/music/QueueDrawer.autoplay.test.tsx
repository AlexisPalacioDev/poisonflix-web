import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../../auth/AuthContext";
import { clearSession, setSession } from "../../lib/session/store";
import { MusicPlayerProvider } from "./MusicPlayerProvider";
import { QueueDrawer } from "./QueueDrawer";
import { getAutoplayPreference } from "../../lib/domain/musicPrefs";

function renderDrawer() {
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
          <QueueDrawer onClose={() => {}} />
        </MusicPlayerProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("QueueDrawer autoplay switch", () => {
  afterEach(() => {
    clearSession();
    localStorage.clear();
  });

  it("starts on and says what it does", () => {
    renderDrawer();
    expect(screen.getByRole("switch", { name: "Autoplay" })).toBeChecked();
    expect(screen.getByText("Sigue con temas similares")).toBeInTheDocument();
  });

  it("turns off, persists the choice, and warns the music will stop", () => {
    renderDrawer();
    fireEvent.click(screen.getByRole("switch", { name: "Autoplay" }));

    expect(screen.getByRole("switch", { name: "Autoplay" })).not.toBeChecked();
    expect(
      screen.getByText("La música para al final de la cola"),
    ).toBeInTheDocument();
    expect(getAutoplayPreference()).toBe(false);
  });
});
