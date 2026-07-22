import { Activity } from "lucide-react";

import { LogoutButton } from "@/components/shared/logout-button";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-white/10 bg-neutral-950 px-4 py-3.5 sm:px-6 md:px-8">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-orange-600">
            <Activity className="size-4 text-white" strokeWidth={2.5} />
          </span>
          <p className="text-base font-semibold tracking-tight text-white">
            LeadFinder
          </p>
        </div>
        <LogoutButton />
      </header>
      {children}
    </div>
  );
}
