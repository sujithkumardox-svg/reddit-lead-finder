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
      className={cn(
        "w-full shadow-sm ring-1 ring-foreground/10 transition-shadow hover:shadow-md",
        className,
      )}
    >
      <CardHeader className="space-y-1.5 pb-4">
        <CardTitle className="text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </CardTitle>
        <CardDescription className="text-sm leading-relaxed sm:text-base">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && <CardFooter className="flex flex-col gap-4 pt-0">{footer}</CardFooter>}
    </Card>
  );
}
