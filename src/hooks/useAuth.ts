// Thin re-export so the hooks layer has a single `useAuth` entry point per
// design.md §2 (`hooks/useAuth.ts # consumes AuthContext`), without every
// consumer reaching into `src/auth/` directly. Full session-store hydration
// and two-phase login land in Slice 3 (`auth/AuthContext.tsx`).
export { useAuthContext as useAuth } from '../auth/useAuthContext';
