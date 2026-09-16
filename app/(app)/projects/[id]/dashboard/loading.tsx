import { LoaderCircle } from "lucide-react";

/**
 * Instant navigation boundary for `/projects/[id]/dashboard`.
 *
 * This route is dynamic (auth + Supabase reads), so without this file
 * Next.js keeps the *previous* page on screen until the dashboard's data
 * is ready - which left the "Finding Your Leads" scanning dialog visible
 * after a first scan completed, since that dialog now closes on its own
 * (see `new-project-wizard.tsx`) but navigation still has to finish
 * rendering the destination page. This boundary gives that navigation its
 * own immediate loading UI instead of leaving stale UI on screen.
 */
export default function DashboardLoading() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-6 text-white sm:px-6">
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <LoaderCircle className="size-4 animate-spin" />
        Loading dashboard…
      </div>
    </main>
  );
}
