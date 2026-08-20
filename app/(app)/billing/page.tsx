import { AppHeader } from "@/components/app-shell/app-header";

export default function BillingPage() {
  return (
    <>
      <AppHeader />
      <main className="flex flex-1 flex-col gap-6 px-6 py-8 text-white">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-neutral-400">Billing is not part of this release.</p>
      </main>
    </>
  );
}
