import { cn } from "@/lib/utils";

type AuthMessageProps = {
  variant: "error" | "success" | "loading";
  children: React.ReactNode;
  className?: string;
};

export function AuthMessage({ variant, children, className }: AuthMessageProps) {
  return (
    <p
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm leading-relaxed",
        variant === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
        variant === "success" &&
          "border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400",
        variant === "loading" &&
          "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
