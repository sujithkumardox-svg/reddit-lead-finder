import Link from "next/link";
import { notFound } from "next/navigation";

import { LeadCard } from "@/components/leads/lead-card";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/services/projects";
import { getLeadStats, listLeadsByProject } from "@/services/reddit-leads";

export default async function ProjectDashboardPage({
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

  const [stats, recentLeads] = await Promise.all([
    getLeadStats(user.id, id),
    listLeadsByProject(user.id, id, { sort: "newest", limit: 4 }),
  ]);

  const statItems = [
    { label: "Total leads", value: stats.total },
    { label: "New", value: stats.newCount },
    { label: "Contacted", value: stats.contactedCount },
    { label: "Strong (8.0–10.0)", value: stats.strongCount },
    { label: "Partial (6.0–7.0)", value: stats.partialCount },
  ];

  return (
    <main className="flex flex-1 flex-col gap-8 overflow-x-hidden px-4 py-6 text-white sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-lg font-medium text-white">{project.name}</p>
          <a
            href={project.websiteUrl}
            target="_blank"
            rel="noreferrer"
            className="block max-w-full break-all text-sm text-neutral-400 underline-offset-4 hover:text-orange-400 hover:underline"
          >
            {project.websiteUrl}
          </a>
          {project.description && (
            <p className="mt-3 max-w-2xl text-sm text-neutral-300">{project.description}</p>
          )}
        </div>
        <Button asChild className="bg-orange-600 text-white hover:bg-orange-500">
          <Link href={`/projects/${id}/leads`}>View all leads</Link>
        </Button>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {statItems.map((item) => (
          <div
            key={item.label}
            className="rounded-xl border border-white/10 bg-neutral-900 px-3 py-4"
          >
            <p className="text-xs text-neutral-400">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold text-white">{item.value}</p>
          </div>
        ))}
      </section>

      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Newest leads</h2>
          <Link
            href={`/projects/${id}/leads`}
            className="text-sm text-orange-400 hover:text-orange-300"
          >
            View all leads
          </Link>
        </div>
        {recentLeads.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-neutral-900 px-4 py-8 text-sm text-neutral-400">
            No qualified leads yet. New leads will show up here after qualification.
          </p>
        ) : (
          <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
            {recentLeads.map((lead) => (
              <LeadCard key={lead.id} lead={lead} projectId={id} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
