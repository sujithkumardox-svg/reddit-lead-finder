"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthCard } from "@/components/shared/auth/auth-card";
import { AuthField } from "@/components/shared/auth/auth-field";
import { AuthLegalFooter } from "@/components/shared/auth/auth-legal-footer";
import { AuthMessage } from "@/components/shared/auth/auth-message";
import { PasswordInput } from "@/components/shared/auth/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    const supabase = createClient();
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=/projects`;

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo,
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    if (data.session) {
      setSuccess("Account created. Redirecting…");
      router.push("/projects");
      router.refresh();
      return;
    }

    setSuccess(
      "Account created. Check your email to confirm your address, then log in.",
    );
    setLoading(false);
  }

  return (
    <AuthCard
      title="Create your account"
      description="Start finding high-intent Reddit leads with AI-powered discovery and outreach tools."
      footer={
        <>
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              Log in
            </Link>
          </p>
          <AuthLegalFooter />
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <AuthField id="email" label="Email">
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
            disabled={loading}
          />
        </AuthField>

        <AuthField id="password" label="Password">
          <PasswordInput
            id="password"
            value={password}
            onChange={setPassword}
            placeholder="At least 6 characters"
            autoComplete="new-password"
            disabled={loading}
            minLength={6}
          />
        </AuthField>

        {loading && (
          <AuthMessage variant="loading">Creating account…</AuthMessage>
        )}
        {error && <AuthMessage variant="error">{error}</AuthMessage>}
        {success && <AuthMessage variant="success">{success}</AuthMessage>}

        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
