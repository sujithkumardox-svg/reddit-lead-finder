"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CalendarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { localDayIsoBounds } from "@/lib/leads/format-lead";
import { cn } from "@/lib/utils";
import type { LeadMatchFilter, LeadSort } from "@/types/reddit-leads";

const SORT_OPTIONS: { value: LeadSort; label: string }[] = [
  { value: "newest", label: "Newest leads" },
  { value: "oldest", label: "Oldest leads" },
  { value: "highest_score", label: "Highest Score" },
  { value: "lowest_score", label: "Lowest Score" },
];

type LeadsToolbarProps = {
  projectId: string;
};

function parseMatchFilters(raw: string | null): LeadMatchFilter[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .filter((value): value is LeadMatchFilter => value === "strong" || value === "partial");
}

export function LeadsToolbar({ projectId }: LeadsToolbarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sort = (searchParams.get("sort") as LeadSort | null) ?? "newest";
  const matchFilters = parseMatchFilters(searchParams.get("match"));
  const dateParam = searchParams.get("date");
  const selectedDate = dateParam ? new Date(`${dateParam}T00:00:00`) : undefined;
  const [calendarOpen, setCalendarOpen] = useState(false);

  function pushParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    router.push(`/projects/${projectId}/leads${query ? `?${query}` : ""}`);
  }

  function toggleMatch(filter: LeadMatchFilter) {
    pushParams((params) => {
      const next = new Set(parseMatchFilters(params.get("match")));
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }
      if (next.size === 0) {
        params.delete("match");
      } else {
        params.set("match", Array.from(next).join(","));
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full justify-start border-white/10 bg-neutral-900 text-neutral-200 md:h-8 md:w-auto"
          >
            <CalendarIcon />
            {dateParam ?? "All dates"}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={12}
          className="w-auto max-w-[calc(100vw-1.5rem)] p-2"
        >
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(day) => {
              pushParams((params) => {
                if (!day) {
                  params.delete("date");
                  params.delete("from");
                  params.delete("to");
                  return;
                }
                const bounds = localDayIsoBounds(day);
                const year = day.getFullYear();
                const month = String(day.getMonth() + 1).padStart(2, "0");
                const date = String(day.getDate()).padStart(2, "0");
                params.set("date", `${year}-${month}-${date}`);
                params.set("from", bounds.from);
                params.set("to", bounds.to);
              });
              setCalendarOpen(false);
            }}
          />
          {dateParam && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-11 w-full md:h-7"
              onClick={() => {
                pushParams((params) => {
                  params.delete("date");
                  params.delete("from");
                  params.delete("to");
                });
                setCalendarOpen(false);
              }}
            >
              Clear date
            </Button>
          )}
        </PopoverContent>
      </Popover>

      <Select
        value={SORT_OPTIONS.some((option) => option.value === sort) ? sort : "newest"}
        onValueChange={(value) => {
          pushParams((params) => {
            if (value === "newest") {
              params.delete("sort");
            } else {
              params.set("sort", value);
            }
          });
        }}
      >
        <SelectTrigger className="h-11 w-full border-white/10 bg-neutral-900 text-neutral-200 data-[size=default]:h-11 md:h-8 md:w-48 md:data-[size=default]:h-8">
          <SelectValue placeholder="Sort" />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-11 w-full border-white/10 md:h-7 md:w-auto",
            matchFilters.includes("strong")
              ? "bg-orange-600 text-white hover:bg-orange-500"
              : "bg-neutral-900 text-neutral-200",
          )}
          onClick={() => toggleMatch("strong")}
        >
          Strong Match (8.0–10.0)
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-11 w-full border-white/10 md:h-7 md:w-auto",
            matchFilters.includes("partial")
              ? "bg-orange-600 text-white hover:bg-orange-500"
              : "bg-neutral-900 text-neutral-200",
          )}
          onClick={() => toggleMatch("partial")}
        >
          Partial Match (6.0–7.0)
        </Button>
      </div>
    </div>
  );
}
