import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

      <Card>
        <CardHeader>
          <CardTitle>Business description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {project.description || "No description yet."}
          </p>
        </CardContent>
      </Card>

      <FieldListCard title="Keywords" items={project.keywords} />
      <FieldListCard title="Intent phrases" items={project.intentPhrases} />
      <FieldListCard title="Pain phrases" items={project.painPhrases} />
      <FieldListCard title="Competitors" items={project.competitors} />
    </main>
  );
}

function FieldListCard({ title, items }: { title: string; items: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{items.length} total</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map((item) => (
              <Badge key={item} variant="secondary">
                {item}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
