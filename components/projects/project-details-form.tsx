"use client";

import { useEffect, useState } from "react";

import { updateProjectAction } from "@/actions/projects";
import { AuthMessage } from "@/components/shared/auth/auth-message";
import { BusinessDescriptionField } from "@/components/projects/business-description-field";
import { EditableListField } from "@/components/projects/editable-list-field";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Project } from "@/types/project";

type EditableFields = Pick<
  Project,
  "description" | "keywords" | "intentPhrases" | "painPhrases" | "competitors"
>;

function toEditableFields(project: Project): EditableFields {
  return {
    description: project.description,
    keywords: project.keywords,
    intentPhrases: project.intentPhrases,
    painPhrases: project.painPhrases,
    competitors: project.competitors,
  };
}

function areEqual(a: EditableFields, b: EditableFields): boolean {
  return (
    a.description === b.description &&
    JSON.stringify(a.keywords) === JSON.stringify(b.keywords) &&
    JSON.stringify(a.intentPhrases) === JSON.stringify(b.intentPhrases) &&
    JSON.stringify(a.painPhrases) === JSON.stringify(b.painPhrases) &&
    JSON.stringify(a.competitors) === JSON.stringify(b.competitors)
  );
}

/**
 * Renders the same editable onboarding fields used during project creation
 * (description, keywords, intent phrases, pain phrases, competitors) for an
 * existing project, plus a fixed Save Changes button that only becomes
 * active once something has actually changed.
 */
export function ProjectDetailsForm({ project }: { project: Project }) {
  const [saved, setSaved] = useState<EditableFields>(() => toEditableFields(project));
  const [fields, setFields] = useState<EditableFields>(() => toEditableFields(project));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = !areEqual(fields, saved);

  useEffect(() => {
    if (!isDirty) return;

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    const result = await updateProjectAction(project.id, fields);

    if (!result.ok) {
      setError(result.error);
      setSaving(false);
      return;
    }

    setSaved(fields);
    setSaving(false);
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Business description</CardTitle>
        </CardHeader>
        <CardContent>
          <BusinessDescriptionField
            value={fields.description}
            onChange={(description) => setFields({ ...fields, description })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keywords</CardTitle>
          <CardDescription>{fields.keywords.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          <EditableListField
            label=""
            items={fields.keywords}
            onChange={(keywords) => setFields({ ...fields, keywords })}
            placeholder="Add a keyword…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Intent phrases</CardTitle>
          <CardDescription>{fields.intentPhrases.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          <EditableListField
            label=""
            items={fields.intentPhrases}
            onChange={(intentPhrases) => setFields({ ...fields, intentPhrases })}
            placeholder="Add an intent phrase…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pain phrases</CardTitle>
          <CardDescription>{fields.painPhrases.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          <EditableListField
            label=""
            items={fields.painPhrases}
            onChange={(painPhrases) => setFields({ ...fields, painPhrases })}
            placeholder="Add a pain phrase…"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Competitors</CardTitle>
          <CardDescription>{fields.competitors.length} total</CardDescription>
        </CardHeader>
        <CardContent>
          <EditableListField
            label=""
            items={fields.competitors}
            onChange={(competitors) => setFields({ ...fields, competitors })}
            placeholder="Add a competitor…"
          />
        </CardContent>
      </Card>

      {error && <AuthMessage variant="error">{error}</AuthMessage>}

      <div className="fixed bottom-6 right-6 z-50">
        <Button
          type="button"
          size="lg"
          disabled={!isDirty || saving}
          onClick={handleSave}
        >
          {saving ? "Saving Changes…" : "Save Changes"}
        </Button>
      </div>
    </>
  );
}
