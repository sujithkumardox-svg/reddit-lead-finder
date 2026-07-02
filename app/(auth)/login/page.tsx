import { LoginForm } from "@/components/shared/login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ verified?: string }>;
}) {
  const { verified } = await searchParams;

  return <LoginForm verifiedEmail={verified === "1"} />;
}
