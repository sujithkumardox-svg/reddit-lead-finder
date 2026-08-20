"use client";

import { useState, useTransition } from "react";
import { ExternalLink, MessageSquare, Send, Trash2 } from "lucide-react";

import { deleteLeadAction, markLeadContactedAction } from "@/actions/leads";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAiScore, formatLeadCreatedAt, formatSubreddit } from "@/lib/leads/format-lead";
import { cn } from "@/lib/utils";
import type { RedditLeadRow, SubredditSafetyBadge } from "@/types/reddit-leads";

const MOBILE_TOUCH_CLASS = "h-11 md:h-7";

const SAFETY_LABEL: Record<SubredditSafetyBadge, string> = {
  without_rules: "Without Rules",
  promo_conditional: "Promo Conditional",
  promo_not_safe: "Promo Not Safe",
};

const SAFETY_CLASS: Record<SubredditSafetyBadge, string> = {
  without_rules: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  promo_conditional: "border-blue-500/40 bg-blue-500/15 text-blue-300",
  promo_not_safe: "border-orange-500/40 bg-orange-500/15 text-orange-300",
};

function ReasonBadge({
  label,
  reason,
  className,
}: {
  label: string;
  reason: string;
  className: string;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const badge = (
    <Badge
      className={cn(
        "h-auto max-w-full min-w-0 whitespace-normal break-words [overflow-wrap:anywhere] border font-medium",
        className,
      )}
      variant="outline"
    >
      {label}
    </Badge>
  );

  if (!reason) {
    return badge;
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex max-w-full rounded-md text-left"
              aria-label={`${label}. ${reason}`}
            >
              {badge}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!popoverOpen && (
          <TooltipContent className="max-w-xs whitespace-normal break-words [overflow-wrap:anywhere] text-left">
            {reason}
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="max-w-[min(20rem,calc(100vw-2rem))] break-words text-left text-sm"
      >
        {reason}
      </PopoverContent>
    </Popover>
  );
}

export function LeadCard({ lead, projectId }: { lead: RedditLeadRow; projectId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isPost = lead.itemType === "post";
  const contacted = lead.status === "contacted";

  function runAction(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
      }
    });
  }

  return (
    <article className="flex h-[28rem] w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900 text-neutral-100 md:w-[22.5rem]">
      <div className="flex items-start justify-between gap-2 border-b border-white/10 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {lead.status === "new" && (
            <Badge className="border-orange-500/40 bg-orange-500/15 text-orange-300" variant="outline">
              New
            </Badge>
          )}
          {contacted && (
            <Badge className="border-white/15 bg-white/10 text-neutral-300" variant="outline">
              Contacted
            </Badge>
          )}
          <Badge className="border-white/15 bg-white/5 text-neutral-300 capitalize" variant="outline">
            {lead.itemType}
          </Badge>
          {lead.subreddit && (
            <span className="truncate text-xs text-neutral-400">{formatSubreddit(lead.subreddit)}</span>
          )}
        </div>
        <p className="shrink-0 text-sm font-semibold text-orange-400">{formatAiScore(lead.aiScore)}</p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-0 space-y-3 px-3 py-3">
          <div className="min-w-0 text-xs text-neutral-400">
            <p className="break-words [overflow-wrap:anywhere]">
              {lead.author}
              {lead.authorId ? ` · ${lead.authorId}` : ""}
            </p>
            <p>{formatLeadCreatedAt(lead.itemCreatedAt)}</p>
            <p>
              {lead.score} upvotes
              {isPost && lead.numComments !== null ? ` · ${lead.numComments} comments` : ""}
            </p>
          </div>

          {isPost && lead.title && (
            <h3
              className={cn(
                "break-words [overflow-wrap:anywhere] text-sm font-medium text-white",
                !expanded && "line-clamp-2",
              )}
            >
              {lead.title}
            </h3>
          )}

          {lead.content && (
            <p
              className={cn(
                "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-neutral-300",
                !expanded && "line-clamp-4",
              )}
            >
              {lead.content}
            </p>
          )}

          {lead.aiLeadSummary && (
            <div className="min-w-0">
              <p className="text-xs font-medium text-neutral-400">Lead Summary</p>
              <p
                className={cn(
                  "break-words [overflow-wrap:anywhere] text-sm text-neutral-200",
                  !expanded && "line-clamp-3",
                )}
              >
                {lead.aiLeadSummary}
              </p>
            </div>
          )}

          {lead.aiMatchReason && (
            <div className="min-w-0">
              <p className="text-xs font-medium text-neutral-400">Match Reason</p>
              <p
                className={cn(
                  "break-words [overflow-wrap:anywhere] text-sm text-neutral-200",
                  !expanded && "line-clamp-3",
                )}
              >
                {lead.aiMatchReason}
              </p>
            </div>
          )}

          <div className="min-h-10 min-w-0 space-y-1">
            <p className="text-xs font-medium text-neutral-400">Possible Competitor</p>
            {lead.aiPossibleCompetitor ? (
              <ReasonBadge
                label={lead.aiPossibleCompetitor}
                reason={lead.aiPossibleCompetitorReason ?? ""}
                className="border-yellow-400/50 bg-yellow-400/15 text-yellow-300"
              />
            ) : (
              <span className="text-xs text-neutral-500">None</span>
            )}
          </div>

          <ReasonBadge
            label={SAFETY_LABEL[lead.safetyBadge]}
            reason={lead.safetyExplanation}
            className={SAFETY_CLASS[lead.safetyBadge]}
          />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              MOBILE_TOUCH_CLASS,
              "px-0 text-orange-400 hover:bg-transparent hover:text-orange-300",
            )}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "View Less" : "View More"}
          </Button>
        </div>
      </ScrollArea>

      <div className="flex flex-col gap-1.5 border-t border-white/10 px-3 py-2.5">
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            title="Coming soon"
            className={cn(MOBILE_TOUCH_CLASS, "border-white/10 text-neutral-500")}
          >
            <Send />
            Send DM
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            title="Coming soon"
            className={cn(MOBILE_TOUCH_CLASS, "border-white/10 text-neutral-500")}
          >
            <MessageSquare />
            Generate Comment
          </Button>
          <Button
            type="button"
            size="sm"
            className={cn(MOBILE_TOUCH_CLASS, "bg-orange-600 text-white hover:bg-orange-500")}
            disabled={pending || contacted}
            onClick={() => runAction(() => markLeadContactedAction(projectId, lead.id))}
          >
            Contacted
          </Button>
          <Button type="button" size="sm" variant="outline" className={cn(MOBILE_TOUCH_CLASS, "border-white/10 text-neutral-200")} asChild>
            <a href={lead.permalink} target="_blank" rel="noreferrer">
              <ExternalLink />
              {isPost ? "View Post" : "View Comment"}
            </a>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className={cn(MOBILE_TOUCH_CLASS)}
            disabled={pending}
            onClick={() => {
              if (window.confirm("Delete this lead permanently?")) {
                runAction(() => deleteLeadAction(projectId, lead.id));
              }
            }}
          >
            <Trash2 />
            Delete
          </Button>
        </div>
        {error && (
          <p className="text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
