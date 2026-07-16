"use client";

import { Textarea } from "@/components/ui/textarea";

const MAX_LENGTH = 800;

type BusinessDescriptionFieldProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

/**
 * The Business Description field, shared by the Project Creation review
 * step and the Project Details editing page so both behave identically:
 * fixed height (~5-6 lines), never auto-expands, not manually resizable,
 * scrolls internally past that height, capped at 800 characters, with a
 * live "x/800 characters" counter.
 */
export function BusinessDescriptionField({
  id,
  value,
  onChange,
  disabled = false,
}: BusinessDescriptionFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={MAX_LENGTH}
        disabled={disabled}
        className="field-sizing-fixed h-32 resize-none overflow-y-auto"
      />
      <p className="text-xs text-muted-foreground">
        {value.length}/{MAX_LENGTH} characters
      </p>
    </div>
  );
}
