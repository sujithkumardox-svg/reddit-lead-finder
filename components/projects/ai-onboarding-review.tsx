import { Circle, LoaderCircle } from "lucide-react";

type OnboardingStep = {
  title: string;
  description?: string;
};

// Phase 1 mock data only. No API calls, timers, or automatic progression -
// the first step is always rendered as active and the rest as upcoming.
const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: "Understanding your business",
    description: "Learning what your product does and who it's for.",
  },
  { title: "Finding your competitors" },
  { title: "Learning your ideal customers" },
  { title: "Building your lead discovery strategy" },
  { title: "Finalizing your project" },
];

const ACTIVE_STEP_INDEX = 0;

// Fixed, hand-picked delays (rather than a computed index * ms) so the
// stagger stays on Tailwind's standard delay scale.
const STEP_ENTRANCE_DELAYS = ["delay-0", "delay-100", "delay-200", "delay-300", "delay-400"];

/**
 * Static Phase 1 UI for the AI onboarding review page. Reassures the user
 * that the AI is preparing their project while the editable onboarding
 * review (a later phase) is not yet available.
 */
export function AiOnboardingReview() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-neutral-950 px-4 py-14 sm:px-6">
      <div className="w-full max-w-md animate-in fade-in slide-in-from-bottom-2 duration-500 ease-out">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Preparing your project
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-neutral-400 sm:text-base">
            Our AI is learning about your business and preparing everything
            needed to find high-quality Reddit leads.
          </p>
        </div>

        <ol className="ml-16 mt-16 flex flex-col gap-7">
          {ONBOARDING_STEPS.map((step, index) => {
            const isActive = index === ACTIVE_STEP_INDEX;

            return (
              <li
                key={step.title}
                className={`flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-400 ${STEP_ENTRANCE_DELAYS[index] ?? ""}`}
              >
                <div className="flex items-center gap-3">
                  {isActive ? (
                    <LoaderCircle className="size-5 shrink-0 animate-spin text-orange-500 transition-colors duration-300" />
                  ) : (
                    <Circle className="size-5 shrink-0 text-neutral-700 transition-colors duration-300" />
                  )}
                  <p
                    className={
                      isActive
                        ? "text-base font-medium text-white transition-colors duration-300"
                        : "text-base font-medium text-neutral-500 transition-colors duration-300"
                    }
                  >
                    {step.title}
                  </p>
                </div>
                {isActive && step.description && (
                  <p className="pl-8 text-sm text-neutral-400">
                    {step.description}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
