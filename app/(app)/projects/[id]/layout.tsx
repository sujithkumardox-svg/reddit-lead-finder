import { notFound } from "next/navigation";

import { ProjectSidebar } from "@/components/app-shell/project-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/services/projects";

export default async function ProjectScopedLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}>) {
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
    <TooltipProvider>
      <div className="dark flex min-h-full flex-1 flex-col bg-neutral-950 md:flex-row">
        <ProjectSidebar
          project={{
            id: project.id,
            name: project.name,
            websiteUrl: project.websiteUrl,
            description: project.description,
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden md:pl-3">{children}</div>
      </div>
    </TooltipProvider>
  );
}
