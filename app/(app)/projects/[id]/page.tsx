import { notFound } from "next/navigation";

import { ProjectDetailsForm } from "@/components/projects/project-details-form";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/services/projects";

export default async function ProjectPage({
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
    <main className="flex flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <a
          href={project.websiteUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
        >
          {project.websiteUrl}
        </a>
      </div>

      <ProjectDetailsForm project={project} />
    </main>
  );
}
