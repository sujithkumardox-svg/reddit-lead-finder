import { cn } from "@/lib/utils";

type AuthFieldProps = {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
};

export function AuthField({ id, label, children, className }: AuthFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
