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

export function LoginForm() {
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
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    setSuccess("Signed in successfully. Redirecting…");
    router.push("/projects");
    router.refresh();
  }

  return (
    <AuthCard
      title="Welcome back"
      description="Sign in to your Reddit Lead Finder account to access your projects and leads."
      footer={
        <>
          <p className="text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              Sign up
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
            placeholder="Your password"
            autoComplete="current-password"
            disabled={loading}
            minLength={6}
          />
          <div className="flex justify-end">
            <Link
              href="/forgot-password"
              className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              Forgot password?
            </Link>
          </div>
        </AuthField>

        {loading && <AuthMessage variant="loading">Signing in…</AuthMessage>}
        {error && <AuthMessage variant="error">{error}</AuthMessage>}
        {success && <AuthMessage variant="success">{success}</AuthMessage>}

        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? "Signing in…" : "Log in"}
        </Button>
      </form>
    </AuthCard>
  );
}
