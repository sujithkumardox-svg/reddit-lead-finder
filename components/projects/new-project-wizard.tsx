"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, Loader2 } from "lucide-react";

import { analyzeWebsiteAction, createProjectAction } from "@/actions/projects";
import { AuthMessage } from "@/components/shared/auth/auth-message";
import { BusinessDescriptionField } from "@/components/projects/business-description-field";
import { EditableListField } from "@/components/projects/editable-list-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ProjectDraft } from "@/types/project";

type Step = "input" | "analyzing" | "review";

const ANALYSIS_MESSAGES = [
  "Reading your website…",
  "Identifying your audience…",
  "Extracting keywords…",
  "Finding competitors…",
  "Mapping buying intent…",
];

export function NewProjectWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("input");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    if (step !== "analyzing") return;

    const interval = setInterval(() => {
      setMessageIndex((index) => (index + 1) % ANALYSIS_MESSAGES.length);
    }, 2500);

    return () => clearInterval(interval);
  }, [step]);

  async function handleAnalyze(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessageIndex(0);
    setStep("analyzing");

    const result = await analyzeWebsiteAction(websiteUrl);

    if (!result.ok) {
      setError(result.error);
      setStep("input");
      return;
    }

    setDraft(result.data);
    setStep("review");
  }

  async function handleCreate() {
    if (!draft) return;
    setError(null);
    setCreating(true);

    const result = await createProjectAction(draft);

    if (!result.ok) {
      setError(result.error);
      setCreating(false);
      return;
    }

    router.push(`/projects/${result.data.id}`);
    router.refresh();
  }

  if (step === "input") {
    return (
      <Card className="mx-auto w-full max-w-lg">
        <CardHeader>
          <CardTitle>Create a project</CardTitle>
          <CardDescription>
            Enter your website URL. We&apos;ll analyze it and set up keyword
            and lead-matching for you automatically.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleAnalyze}>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="websiteUrl" className="text-sm font-medium text-foreground">
                Website URL
              </label>
              <div className="relative">
                <Globe className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="websiteUrl"
                  type="text"
                  inputMode="url"
                  placeholder="acme.com"
                  className="pl-8"
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  required
                  autoFocus
                />
              </div>
            </div>

            {error && <AuthMessage variant="error">{error}</AuthMessage>}
          </CardContent>
          <CardFooter>
            <Button type="submit" size="lg" className="w-full">
              Analyze website
            </Button>
          </CardFooter>
        </form>
      </Card>
    );
  }

  if (step === "analyzing") {
    return (
      <Card className="mx-auto w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <Loader2 className="size-8 animate-spin text-primary" />
          <div>
            <p className="font-medium text-foreground">
              Analyzing {websiteUrl}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {ANALYSIS_MESSAGES[messageIndex]}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!draft) return null;

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Review your project</CardTitle>
        <CardDescription>
          {draft.name} · {draft.websiteUrl}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="description" className="text-sm font-medium text-foreground">
            Business description
          </label>
          <BusinessDescriptionField
            id="description"
            value={draft.description}
            onChange={(description) => setDraft({ ...draft, description })}
          />
        </div>

        <EditableListField
          label="Keywords"
          description="Terms people use when discussing this space."
          items={draft.keywords}
          onChange={(keywords) => setDraft({ ...draft, keywords })}
          placeholder="Add a keyword…"
        />

        <EditableListField
          label="Intent phrases"
          description="Phrases that signal someone is looking for a solution."
          items={draft.intentPhrases}
          onChange={(intentPhrases) => setDraft({ ...draft, intentPhrases })}
          placeholder="Add an intent phrase…"
        />

        <EditableListField
          label="Pain phrases"
          description="Phrases that signal frustration with the problem you solve."
          items={draft.painPhrases}
          onChange={(painPhrases) => setDraft({ ...draft, painPhrases })}
          placeholder="Add a pain phrase…"
        />

        <EditableListField
          label="Competitors"
          items={draft.competitors}
          onChange={(competitors) => setDraft({ ...draft, competitors })}
          placeholder="Add a competitor…"
        />

        {error && <AuthMessage variant="error">{error}</AuthMessage>}
      </CardContent>
      <CardFooter className="flex justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={creating}
          onClick={() => {
            setDraft(null);
            setError(null);
            setStep("input");
          }}
        >
          Start over
        </Button>
        <Button type="button" size="lg" disabled={creating} onClick={handleCreate}>
          {creating ? "Creating…" : "Create project"}
        </Button>
      </CardFooter>
    </Card>
  );
}
