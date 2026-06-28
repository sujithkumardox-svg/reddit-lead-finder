import Link from "next/link";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1">
      <aside
        className="hidden w-full max-w-md flex-col justify-between border-r bg-muted/40 px-8 py-10 lg:flex lg:max-w-lg lg:px-12 xl:max-w-xl"
        aria-hidden="false"
      >
        <div>
          <p className="text-lg font-semibold tracking-tight text-foreground">
            Reddit Lead Finder
          </p>
        </div>
        <div className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground xl:text-4xl">
            Find high-intent leads on Reddit
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            Discover conversations where your ideal customers are asking for
            help, then turn those moments into qualified opportunities with AI.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          Trusted by teams building smarter outbound workflows.
        </p>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between px-4 py-5 sm:px-6 lg:px-10">
          <p className="text-base font-semibold tracking-tight lg:hidden">
            Reddit Lead Finder
          </p>
          <Link
            href="/"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            Back to home
          </Link>
        </header>

        <main className="flex flex-1 flex-col items-center justify-center px-4 pb-10 sm:px-6 lg:px-10">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
