"use client";

import { useEffect, useState } from "react";

const DOT_FRAMES = [".", "..", "..."];
const DOT_INTERVAL_MS = 500;

// Full-ring spinner: a bright orange head fades into a soft trailing glow,
// then into a dark, faded orange track (not gray) as it wraps back around -
// same brand orange (#f97316 / orange-500) used everywhere else in the app.
const SPINNER_RING_STYLE = {
  background:
    "conic-gradient(from 0deg, #f97316 0%, rgba(249,115,22,0.45) 22%, rgba(249,115,22,0.12) 50%, rgba(249,115,22,0.45) 78%, #f97316 100%)",
  WebkitMaskImage:
    "radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px))",
  maskImage:
    "radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px))",
  filter: "drop-shadow(0 0 5px rgba(249,115,22,0.35))",
} as const;

// Soft, layered glow behind the animated dots - same brand orange as the
// spinner, kept subtle so it reads as premium rather than flashy.
const DOTS_GLOW_STYLE = {
  textShadow: "0 0 6px rgba(249,115,22,0.6), 0 0 14px rgba(249,115,22,0.3)",
} as const;

/**
 * Simple loading screen shown while the backend runs AI onboarding. Purely
 * presentational - no progress steps, no backend polling. Only the
 * trailing dots on the status text animate, continuously and forever; the
 * "Analyzing website" text itself never changes.
 */
export function AiOnboardingReview() {
  const [dotFrameIndex, setDotFrameIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotFrameIndex((index) => (index + 1) % DOT_FRAMES.length);
    }, DOT_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-neutral-950 px-4 py-14 sm:px-6">
      <div className="w-full max-w-md animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Preparing your project
        </h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-neutral-400 sm:text-base">
          We&apos;re analyzing your website, understanding your business,
          identifying relevant competitors, understanding your ideal
          customers, and preparing everything needed to find high‑quality
          Reddit leads.
        </p>

        <div
          className="mx-auto mt-12 size-14 animate-spin rounded-full"
          style={SPINNER_RING_STYLE}
        />

        <p className="mt-6 text-lg font-medium text-white">
          Analyzing website
          <span
            className="ml-1 inline-block w-9 text-left tracking-[0.35em] text-orange-500"
            style={DOTS_GLOW_STYLE}
          >
            {DOT_FRAMES[dotFrameIndex]}
          </span>
        </p>
        <p className="mt-2 text-base text-neutral-400">This may take a few moments.</p>
      </div>
    </div>
  );
}
