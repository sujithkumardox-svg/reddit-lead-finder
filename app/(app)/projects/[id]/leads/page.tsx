import { notFound } from "next/navigation";
import { Suspense } from "react";

import { LeadCard } from "@/components/leads/lead-card";
import { LeadsToolbar } from "@/components/leads/leads-toolbar";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/services/projects";
import { listLeadsByProject } from "@/services/reddit-leads";
import type { LeadMatchFilter, LeadSort, ListLeadsOptions } from "@/types/reddit-leads";

const SORTS: LeadSort[] = ["newest", "oldest", "highest_score", "lowest_score"];

function parseSort(value: string | undefined): LeadSort {
  return SORTS.includes(value as LeadSort) ? (value as LeadSort) : "newest";
}

function parseMatchFilters(value: string | undefined): LeadMatchFilter[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .filter((item): item is LeadMatchFilter => item === "strong" || item === "partial");
}

export default async function ProjectLeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
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

  const sort = parseSort(typeof query.sort === "string" ? query.sort : undefined);
  const matchFilters = parseMatchFilters(typeof query.match === "string" ? query.match : undefined);
  const options: ListLeadsOptions = {
    sort,
    matchFilters,
  };

  if (typeof query.from === "string" && typeof query.to === "string") {
    options.dateFrom = query.from;
    options.dateTo = query.to;
  }

  const leads = await listLeadsByProject(user.id, id, options);

  return (
    <main className="flex flex-1 flex-col gap-6 overflow-x-hidden px-4 py-6 text-white sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Qualified Reddit leads for {project.name}, newest first by default.
        </p>
      </div>

      <Suspense fallback={null}>
        <LeadsToolbar projectId={id} />
      </Suspense>

      {leads.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-neutral-900 px-4 py-8 text-sm text-neutral-400">
          No leads match the current filters.
        </p>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} projectId={id} />
          ))}
        </div>
      )}
    </main>
  );
}
