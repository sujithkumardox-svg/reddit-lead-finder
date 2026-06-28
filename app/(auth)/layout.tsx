import { AuthShell } from "@/components/shared/auth/auth-shell";

export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AuthShell>{children}</AuthShell>;
}
