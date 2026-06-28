import Link from "next/link";

export function AuthLegalFooter() {
  return (
    <p className="text-center text-xs leading-relaxed text-muted-foreground">
      By continuing, you agree to our{" "}
      <Link
        href="/terms"
        className="font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
      >
        Terms of Service
      </Link>{" "}
      and{" "}
      <Link
        href="/privacy"
        className="font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
      >
        Privacy Policy
      </Link>
      .
    </p>
  );
}
