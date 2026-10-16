"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, Globe, LoaderCircle, Sparkles } from "lucide-react";

import { analyzeWebsiteAction, createProjectAction, validateWebsiteAction } from "@/actions/projects";
import { getProjectScanStatusAction, startProjectScanAction } from "@/actions/scans";
import { AiOnboardingReview } from "@/components/projects/ai-onboarding-review";
import { FindingLeadsDialog } from "@/components/projects/finding-leads-dialog";
import { ProjectSavedDialog } from "@/components/projects/project-saved-dialog";
import { AuthMessage } from "@/components/shared/auth/auth-message";
import { BusinessDescriptionField } from "@/components/projects/business-description-field";
import { EditableListField } from "@/components/projects/editable-list-field";
import { isCompletedScanReadyToNavigate } from "@/lib/scans/dashboard-navigation";
import { SCAN_POLL_INTERVAL_MS } from "@/lib/scans/scan-progress";
import { Button } from "@/components/ui/button";
import type { ScanProgressStage } from "@/types/sync-logs";
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
type WebsiteValidationStatus = "idle" | "invalid" | "validating" | "valid";

const WEBSITE_VALIDATION_DEBOUNCE_MS = 700;

/** Lightweight, local-only sanity check - no network request. */
function looksLikeWebsite(value: string): boolean {
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(value.trim());
}

/**
 * How long the HTML-declared-favicon fallback fetch (see
 * `discoverDeclaredFaviconUrl`) is allowed to run before giving up. Kept
 * short since this only ever runs after the primary (Google) favicon has
 * already failed to load - it must not noticeably delay the existing
 * generic Globe-icon fallback for sites where nothing works.
 */
const FAVICON_FALLBACK_FETCH_TIMEOUT_MS = 5_000;

/**
 * Pulls the `href` of the first HTML-declared favicon
 * (`<link rel="icon" ...>` or `<link rel="shortcut icon" ...>`) out of a
 * raw HTML string. Intentionally a plain regex scan rather than
 * `DOMParser` - this keeps the helper a dependency-free, environment-
 * agnostic string transform (works the same in the browser and under
 * Vitest's Node test environment, with nothing new to install or
 * configure), which is all this narrow lookup needs.
 *
 * Mirrors the semantics of the CSS attribute selector `[rel~="icon"]`:
 * matches `rel="icon"` and `rel="shortcut icon"` (and any other
 * whitespace-separated rel list that includes the "icon" token), but not
 * unrelated rel values like `apple-touch-icon`.
 */
export function extractDeclaredFaviconHref(html: string): string | null {
  const linkTagPattern = /<link\b[^>]*>/gi;

  for (const match of html.matchAll(linkTagPattern)) {
    const tag = match[0];

    const relMatch = /\brel\s*=\s*(['"])(.*?)\1/i.exec(tag);
    if (!relMatch) continue;

    const relTokens = relMatch[2].toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes("icon")) continue;

    const hrefMatch = /\bhref\s*=\s*(['"])(.*?)\1/i.exec(tag);
    if (hrefMatch && hrefMatch[2].trim()) return hrefMatch[2].trim();
  }

  return null;
}

/**
 * Resolves a (possibly relative) favicon `href` against the page it was
 * declared on. Returns null instead of throwing for a malformed href/page
 * URL - callers treat that exactly like "no fallback available".
 */
export function resolveFaviconHref(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Looks for an HTML-declared favicon on `pageUrl` and resolves it to an
 * absolute URL, entirely from the browser. This is an ordinary, same-
 * origin-policy-governed `fetch()` of a public page URL - not a server-
 * side request - so it can only ever succeed against pages that
 * explicitly allow cross-origin reads of their HTML (via CORS); it has no
 * access to anything a server-side fetch would (internal network, etc.),
 * so it introduces no SSRF surface.
 *
 * Every failure mode (network error, CORS block, timeout, missing/
 * unparsable favicon link) is treated identically: resolve to null so the
 * caller keeps its existing generic-icon fallback. Bounded by a single
 * fetch with a timeout - never retries on its own.
 */
export async function discoverDeclaredFaviconUrl(pageUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FAVICON_FALLBACK_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(pageUrl, { signal: controller.signal });
    if (!response.ok) return null;

    const html = await response.text();
    const href = extractDeclaredFaviconHref(html);

    return href ? resolveFaviconHref(href, pageUrl) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Drives a single favicon `<img>` through: the existing primary source
 * (e.g. Google's favicon service, passed in as `primaryUrl`) first - if
 * and only if that fails to load, one bounded attempt to discover and use
 * the website's own HTML-declared favicon (via `discoverDeclaredFaviconUrl`
 * against `pageUrl`) - and if that also fails, or nothing was found,
 * `src` becomes null so the caller falls back to its existing generic
 * icon / hidden-image behavior. Never retries beyond that single fallback
 * attempt.
 *
 * Resets whenever `pageUrl` changes, and guards (`attemptedForRef`)
 * against a slow, now-stale discovery request overwriting state for a
 * newer URL - the same stale-request protection pattern used by
 * `validationRequestRef` above, scoped to this one concern.
 */
function useFaviconWithFallback(primaryUrl: string | null, pageUrl: string | null) {
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  const attemptedForRef = useRef<string | null>(null);

  useEffect(() => {
    setPrimaryFailed(false);
    setFallbackUrl(null);
    setFallbackFailed(false);
    attemptedForRef.current = null;
  }, [pageUrl]);

  const usingFallback = primaryFailed && Boolean(fallbackUrl) && !fallbackFailed;
  const src = !primaryFailed ? primaryUrl : usingFallback ? fallbackUrl : null;

  function handleError() {
    if (usingFallback) {
      // The fallback image itself just failed to load - final state,
      // caller shows its generic icon. No further attempts.
      setFallbackFailed(true);
      return;
    }

    setPrimaryFailed(true);

    if (!pageUrl || attemptedForRef.current === pageUrl) return;
    attemptedForRef.current = pageUrl;

    void discoverDeclaredFaviconUrl(pageUrl).then((discovered) => {
      // `pageUrl` changed (new website typed, or a newer draft) since this
      // attempt started - ignore the now-stale result.
      if (attemptedForRef.current !== pageUrl) return;
      if (discovered) setFallbackUrl(discovered);
    });
  }

  return { src, handleError };
}

export function NewProjectWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("input");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [originalDraft, setOriginalDraft] = useState<ProjectDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savedProjectId, setSavedProjectId] = useState<string | null>(null);
  const [showSavedDialog, setShowSavedDialog] = useState(false);
  const [startingScan, setStartingScan] = useState(false);
  const [showFindingDialog, setShowFindingDialog] = useState(false);
  const [scanStage, setScanStage] = useState<ScanProgressStage>("scanning");
  const [scanError, setScanError] = useState<string | null>(null);
  const [validationStatus, setValidationStatus] = useState<WebsiteValidationStatus>("idle");
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [validatedWebsiteUrl, setValidatedWebsiteUrl] = useState<string | null>(null);
  const validationRequestRef = useRef(0);

  // Input-step favicon: primary (Google) source from `faviconUrl`, with a
  // bounded fallback to the website's own HTML-declared favicon - see
  // `useFaviconWithFallback`. `validatedWebsiteUrl` (the normalized URL
  // returned by `validateWebsiteAction`, not the raw text the user is
  // typing) is what the fallback fetches and resolves relative hrefs
  // against.
  const { src: inputFaviconSrc, handleError: handleInputFaviconError } = useFaviconWithFallback(
    faviconUrl,
    validatedWebsiteUrl,
  );

  // Review-step favicon: same primary + bounded-fallback behavior as the
  // input step, keyed off the (fixed, already-normalized) `draft.websiteUrl`
  // instead of the live-typed/validated input. Must be called
  // unconditionally (Rules of Hooks) even before `draft` exists - the hook
  // already treats a null `primaryUrl`/`pageUrl` as "nothing to show".
  // Identical URL construction to the original inline JSX expression it
  // replaces, just hoisted so it can be passed into the hook.
  const reviewPrimaryFaviconUrl = draft
    ? `https://www.google.com/s2/favicons?sz=64&domain=${new URL(draft.websiteUrl).hostname}`
    : null;
  const { src: reviewFaviconSrc, handleError: handleReviewFaviconError } = useFaviconWithFallback(
    reviewPrimaryFaviconUrl,
    draft?.websiteUrl ?? null,
  );

  const isDirty =
    draft !== null &&
    originalDraft !== null &&
    (draft.description !== originalDraft.description ||
      JSON.stringify(draft.keywords) !== JSON.stringify(originalDraft.keywords) ||
      JSON.stringify(draft.intentPhrases) !== JSON.stringify(originalDraft.intentPhrases) ||
      JSON.stringify(draft.painPhrases) !== JSON.stringify(originalDraft.painPhrases) ||
      JSON.stringify(draft.competitors) !== JSON.stringify(originalDraft.competitors));

  useEffect(() => {
    if (!isDirty) return;

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  // Lightweight, debounced website validation shown while the user is
  // still on the input step. Reuses the existing, independent
  // validateWebsiteAction() - never calls analyzeWebsiteAction() (AI
  // onboarding only starts when the user explicitly clicks the button).
  useEffect(() => {
    if (step !== "input") return;

    // Every input change immediately clears the previous validation
    // result - no outdated favicon/message/button state is ever shown.
    // Clearing `validatedWebsiteUrl` here also resets the favicon
    // fallback's own state (see `useFaviconWithFallback`'s effect).
    validationRequestRef.current += 1;
    setValidationStatus("idle");
    setFaviconUrl(null);
    setValidatedWebsiteUrl(null);

    const trimmed = websiteUrl.trim();
    if (!trimmed) return;

    const timer = setTimeout(() => {
      if (!looksLikeWebsite(trimmed)) {
        setValidationStatus("invalid");
        return;
      }

      const requestId = validationRequestRef.current;
      setValidationStatus("validating");

      validateWebsiteAction(trimmed).then((result) => {
        // A newer input change/request has superseded this one - ignore.
        if (validationRequestRef.current !== requestId) return;

        if (!result.ok) {
          setValidationStatus("invalid");
          return;
        }

        setFaviconUrl(result.data.faviconUrl);
        setValidatedWebsiteUrl(result.data.websiteUrl);
        setValidationStatus("valid");
      });
    }, WEBSITE_VALIDATION_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [websiteUrl, step]);

  useEffect(() => {
    if (
      !showFindingDialog ||
      !savedProjectId ||
      scanStage === "failed" ||
      scanStage === "completed"
    ) {
      return;
    }

    let cancelled = false;
    // See `isCompletedScanReadyToNavigate` - stops a redundant "completed"
    // poll (already in flight, or from an interval tick that fires before
    // this effect is cleaned up) from repeating the dashboard navigation.
    let hasNavigated = false;
    let inFlight = false;

    async function pollStatus() {
      if (cancelled || hasNavigated || inFlight) return;
      inFlight = true;

      try {
        const result = await getProjectScanStatusAction(savedProjectId!);
        if (cancelled || hasNavigated) return;

        if (!result.ok) {
          if (result.retryable) {
            setScanError(result.error);
            return;
          }
          setScanStage("failed");
          setScanError(result.error);
          return;
        }

        setScanStage(result.data.stage);
        setScanError(result.data.errorMessage);

        if (result.data.stage === "completed") {
          // Close the scanning/loading dialog immediately once the backend
          // reports completion - do not wait for navigation to unmount this
          // component. This is independent of `leadsFound`/lead count, and
          // independent of the one-shot navigation guard below: repeating
          // this on a redundant poll is a harmless no-op.
          setShowFindingDialog(false);
        }

        if (
          isCompletedScanReadyToNavigate(result.data.stage, result.data.dashboardPath, hasNavigated)
        ) {
          hasNavigated = true;
          // Stop polling synchronously now instead of only relying on this
          // effect's cleanup (which runs on React's next render and can be
          // outraced by the next interval tick) - this is what previously
          // allowed a second "completed" poll to repeat the navigation.
          window.clearInterval(interval);
          // A single router.push() is enough: the dashboard route is fully
          // dynamic (auth + fresh Supabase reads), so it never needs an
          // immediate router.refresh() here - calling both back-to-back
          // raced the refresh (of this still-current /projects/new route)
          // against the push, which could leave the app on /projects/new.
          router.push(result.data.dashboardPath);
        }
      } finally {
        inFlight = false;
      }
    }

    void pollStatus();
    const interval = window.setInterval(() => {
      void pollStatus();
    }, SCAN_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [showFindingDialog, savedProjectId, scanStage, router]);

  async function handleAnalyze(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsAnalyzing(true);

    // setIsAnalyzing(true) and setStep("analyzing") would otherwise land in
    // the same React batch, so the button's loading state would never
    // actually get painted before the screen swaps. A single
    // requestAnimationFrame callback still runs BEFORE that frame's paint,
    // so it's not enough on its own. Chaining two forces the browser to
    // actually paint the loading button in between (rAF #1 lets the
    // current frame paint; rAF #2 - scheduled from inside rAF #1 - only
    // fires before the *next* frame). No timers, no artificial delay -
    // just waiting for two real paint cycles.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    setStep("analyzing");

    const result = await analyzeWebsiteAction(websiteUrl);

    if (!result.ok) {
      setError(result.error);
      setIsAnalyzing(false);
      setStep("input");
      return;
    }

    setDraft(result.data);
    setOriginalDraft(result.data);
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

    setOriginalDraft(draft);
    setSavedProjectId(result.data.id);
    setCreating(false);
    setShowSavedDialog(true);
  }

  async function handleFindCustomers() {
    if (!savedProjectId) return;

    setError(null);
    setStartingScan(true);
    setScanError(null);
    setScanStage("scanning");

    const result = await startProjectScanAction(savedProjectId);

    if (!result.ok) {
      setStartingScan(false);
      setShowSavedDialog(false);
      setShowFindingDialog(true);
      setScanStage("failed");
      setScanError(result.error);
      return;
    }

    setStartingScan(false);
    setShowSavedDialog(false);
    setShowFindingDialog(true);
  }

  function handleDismissFailedScan() {
    setShowFindingDialog(false);
    setShowSavedDialog(true);
    setScanError(null);
    setScanStage("scanning");
  }

  if (step === "input") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-neutral-950 px-4 py-14 sm:px-6">
        <div className="w-full max-w-md">
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Let&apos;s find your first
              <br />
              Reddit customers.
            </h1>
            <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-neutral-400 sm:text-base">
              Enter your website and our AI will understand your business,
              generate keywords, identify competitors, and prepare your first
              Reddit lead-finding project.
            </p>
          </div>

          <form onSubmit={handleAnalyze} className="mt-8 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="websiteUrl" className="text-sm font-medium text-neutral-200">
                Website
              </label>
              <div className="relative">
                {validationStatus === "valid" && inputFaviconSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={inputFaviconSrc}
                    alt=""
                    className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 rounded-sm"
                    onError={handleInputFaviconError}
                  />
                ) : (
                  <Globe className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-neutral-500" />
                )}
                <Input
                  id="websiteUrl"
                  type="text"
                  inputMode="url"
                  placeholder="https://yourcompany.com"
                  className="h-12 rounded-xl border-white/10 bg-white/[0.03] pl-10 text-base text-white placeholder:text-neutral-500 focus-visible:border-orange-600/60 focus-visible:ring-orange-600/20"
                  value={websiteUrl}
                  onChange={(event) => setWebsiteUrl(event.target.value)}
                  required
                  autoFocus
                />
              </div>
              {validationStatus === "invalid" && (
                <p className="text-xs text-rose-400">
                  Please enter a valid and reachable website
                </p>
              )}
              {validationStatus === "validating" && (
                <p className="flex items-center gap-1.5 text-xs text-orange-500">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Validating...
                </p>
              )}
              {validationStatus === "valid" && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <CheckCircle className="size-3.5" />
                  Website is valid and reachable
                </p>
              )}
            </div>

            {error && <AuthMessage variant="error">{error}</AuthMessage>}

            <Button
              type="submit"
              size="lg"
              disabled={isAnalyzing || validationStatus !== "valid"}
              className="mt-2 h-12 w-full rounded-xl bg-orange-500 text-base font-semibold text-white hover:bg-orange-600 active:bg-orange-700"
            >
              {isAnalyzing ? (
                <LoaderCircle data-icon="inline-start" className="size-4 animate-spin" />
              ) : (
                <Sparkles data-icon="inline-start" className="size-4" />
              )}
              Analyze Website
            </Button>
          </form>
        </div>
      </div>
    );
  }

  if (step === "analyzing") {
    return <AiOnboardingReview />;
  }

  if (!draft) return null;

  return (
    <div className="dark flex flex-1 flex-col bg-neutral-950 px-4 pt-10 pb-14 text-white animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out sm:px-6">
      <div className="mx-auto w-full max-w-2xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Project Details
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-neutral-400 sm:text-base">
          We&apos;ve analyzed your website. Please review and update the
          project details before saving.
        </p>
      </div>

      <Card className="[--card-spacing:1.5rem] mx-auto mt-10 w-full max-w-[45rem] rounded-2xl border border-orange-500/40 bg-neutral-900/60 text-white ring-0">
        <CardHeader>
          <CardTitle className="text-center text-lg font-semibold text-white">
            Review your project
          </CardTitle>
          <div className="mt-4 flex min-w-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={reviewFaviconSrc ?? undefined}
              alt=""
              className="size-7 shrink-0 rounded-md"
              style={reviewFaviconSrc ? undefined : { visibility: "hidden" }}
              onError={handleReviewFaviconError}
            />
            <div className="flex min-w-0 flex-col">
              <p className="truncate text-sm font-medium text-white">{draft.name}</p>
              <CardDescription className="truncate text-neutral-400">
                {draft.websiteUrl}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-8">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-white">Business description</h3>
            <BusinessDescriptionField
              value={draft.description}
              onChange={(description) => setDraft({ ...draft, description })}
            />
          </div>

          <EditableListField
            label="Keywords"
            description={`${draft.keywords.length}/20 keywords`}
            items={draft.keywords}
            onChange={(keywords) => setDraft({ ...draft, keywords })}
            placeholder="Add a keyword…"
            maxItems={20}
          />

          <EditableListField
            label="Intent phrases"
            description={`${draft.intentPhrases.length}/15 intent phrases`}
            items={draft.intentPhrases}
            onChange={(intentPhrases) => setDraft({ ...draft, intentPhrases })}
            placeholder="Add an intent phrase…"
            maxItems={15}
          />

          <EditableListField
            label="Pain phrases"
            description={`${draft.painPhrases.length}/15 pain phrases`}
            items={draft.painPhrases}
            onChange={(painPhrases) => setDraft({ ...draft, painPhrases })}
            placeholder="Add a pain phrase…"
            maxItems={15}
          />

          <EditableListField
            label="Competitors"
            description={`${draft.competitors.length}/5 competitors`}
            items={draft.competitors}
            onChange={(competitors) => setDraft({ ...draft, competitors })}
            placeholder="Add a competitor…"
            maxItems={5}
          />

          {error && <AuthMessage variant="error">{error}</AuthMessage>}
        </CardContent>
        <CardFooter className="flex justify-center gap-3 border-white/10 bg-transparent">
          <Button
            type="button"
            size="lg"
            disabled={creating || Boolean(savedProjectId)}
            onClick={handleCreate}
            className="h-12 w-full max-w-md rounded-xl bg-orange-500 text-base font-semibold text-white hover:bg-orange-600 active:bg-orange-700"
          >
            Save and Continue
          </Button>
        </CardFooter>
      </Card>

      <ProjectSavedDialog
        open={showSavedDialog}
        starting={startingScan}
        onFindCustomers={() => {
          void handleFindCustomers();
        }}
      />
      <FindingLeadsDialog
        open={showFindingDialog}
        stage={scanStage}
        errorMessage={scanError}
        onDismissFailed={handleDismissFailedScan}
      />
    </div>
  );
}
