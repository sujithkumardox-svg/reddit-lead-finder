import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type AuthCardProps = {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
};

export function AuthCard({
  title,
  description,
  children,
  footer,
  className,
}: AuthCardProps) {
  return (
    <Card
      size="sm"
      className={cn(
        "w-full shadow-sm ring-1 ring-foreground/10 transition-shadow hover:shadow-md",
        className,
      )}
    >
      <CardHeader className="space-y-1 pb-3">
        <CardTitle className="text-xl font-semibold tracking-tight">
          {title}
        </CardTitle>
        <CardDescription className="text-sm leading-snug">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
      {footer && (
        <CardFooter className="flex flex-col gap-3 border-0 bg-transparent pt-3 pb-0">
          {footer}
        </CardFooter>
      )}
    </Card>
  );
}
