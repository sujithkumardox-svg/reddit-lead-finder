"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export function LogoutButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: signOutError } = await supabase.auth.signOut();

    if (signOutError) {
      setError(signOutError.message);
      setLoading(false);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  const label = loading ? "Signing out" : "Log out";

  return (
    <div className={cn("flex flex-col gap-1", iconOnly ? "items-center" : "items-end")}>
      <Button
        type="button"
        variant="ghost"
        size={iconOnly ? "icon" : "default"}
        onClick={handleLogout}
        disabled={loading}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        className="text-neutral-400 hover:bg-white/5 hover:text-white"
      >
        <LogOut data-icon="inline-start" />
        {!iconOnly && (loading ? "Signing out…" : "Log out")}
      </Button>
      {error && (
        <p
          className={cn("text-xs text-destructive", iconOnly && "sr-only")}
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
