import Link from "next/link";
import { Plus } from "lucide-react";

import { AppHeader } from "@/components/app-shell/app-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { listProjects } from "@/services/projects";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const projects = user ? await listProjects(user.id) : [];

  return (
    <>
      <AppHeader />
      <main className="flex flex-1 flex-col gap-6 px-6 py-8 text-white">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-neutral-400">
            Projects you&apos;re monitoring for Reddit leads.
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus data-icon="inline-start" />
            New project
          </Link>
        </Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="font-medium text-foreground">No projects yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Create your first project and we&apos;ll analyze your website to
              start finding Reddit leads.
            </p>
            <Button asChild>
              <Link href="/projects/new">Create a project</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}/dashboard`}>
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription>{project.websiteUrl}</CardDescription>
                </CardHeader>
                {project.description && (
                  <CardContent>
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {project.description}
                    </p>
                  </CardContent>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
    </>
  );
}
