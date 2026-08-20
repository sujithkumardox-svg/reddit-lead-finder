import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/services/projects";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    notFound();
  }

  const project = await getProjectById(user.id, id);
  if (!project) {
    notFound();
  }

  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-6 text-white sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Campaign settings for {project.name}.
        </p>
      </div>
      <div className="max-w-lg rounded-xl border border-white/10 bg-neutral-900 p-4">
        <p className="text-sm text-neutral-300">
          Keywords, phrases, and competitors are edited on the campaign details page.
        </p>
        <Button asChild className="mt-4 bg-orange-600 text-white hover:bg-orange-500">
          <Link href={`/projects/${id}`}>Edit campaign details</Link>
        </Button>
      </div>
    </main>
  );
}
