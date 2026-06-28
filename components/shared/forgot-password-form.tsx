"use client";

import Link from "next/link";
import { useState } from "react";

import { AuthCard } from "@/components/shared/auth/auth-card";
import { AuthField } from "@/components/shared/auth/auth-field";
import { AuthMessage } from "@/components/shared/auth/auth-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      { redirectTo },
    );

    if (resetError) {
      setError(resetError.message);
      setLoading(false);
      return;
    }

    setSuccess(
      "If an account exists for this email, we sent a password reset link. Check your inbox and follow the instructions.",
    );
    setLoading(false);
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email associated with your account and we'll send you a secure link to set a new password."
      footer={
        <p className="text-center text-sm text-muted-foreground">
          Remember your password?{" "}
          <Link
            href="/login"
            className="font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            Back to log in
          </Link>
        </p>
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

        {loading && (
          <AuthMessage variant="loading">Sending reset link…</AuthMessage>
        )}
        {error && <AuthMessage variant="error">{error}</AuthMessage>}
        {success && <AuthMessage variant="success">{success}</AuthMessage>}

        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? "Sending reset link…" : "Send reset link"}
        </Button>
      </form>
    </AuthCard>
  );
}
