import { AppHeader } from "@/components/app-shell/app-header";
import { LogoutButton } from "@/components/shared/logout-button";
import { createClient } from "@/lib/supabase/server";

export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <AppHeader />
      <main className="flex flex-1 flex-col gap-6 px-6 py-8 text-white">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="mt-1 text-sm text-neutral-400">Your LeadFinder account.</p>
        </div>
        <div className="max-w-lg rounded-xl border border-white/10 bg-neutral-900 p-4">
          <p className="text-sm text-neutral-300">{user?.email ?? "Signed in"}</p>
          <div className="mt-4">
            <LogoutButton />
          </div>
        </div>
      </main>
    </>
  );
}
