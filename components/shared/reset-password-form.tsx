"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AuthCard } from "@/components/shared/auth/auth-card";
import { AuthField } from "@/components/shared/auth/auth-field";
import { AuthMessage } from "@/components/shared/auth/auth-message";
import { PasswordInput } from "@/components/shared/auth/password-input";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasValidSession, setHasValidSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    async function verifySession() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      setHasValidSession(Boolean(user));
      setCheckingSession(false);

      if (!user) {
        setError(
          "This reset link is invalid or has expired. Request a new password reset email.",
        );
      }
    }

    verifySession();
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match. Please try again.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);

    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    setSuccess("Your password has been updated. Redirecting to your dashboard…");
    router.push("/projects");
    router.refresh();
  }

  if (checkingSession) {
    return (
      <AuthCard
        title="Set a new password"
        description="Verifying your reset link…"
      >
        <AuthMessage variant="loading">Checking your reset link…</AuthMessage>
      </AuthCard>
    );
  }

  if (!hasValidSession) {
    return (
      <AuthCard
        title="Reset link expired"
        description="We couldn't verify your password reset session."
        footer={
          <p className="text-center text-sm text-muted-foreground">
            <Link
              href="/forgot-password"
              className="font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              Request a new reset link
            </Link>
          </p>
        }
      >
        {error && <AuthMessage variant="error">{error}</AuthMessage>}
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set a new password"
      description="Choose a strong password you haven't used before on this account."
      footer={
        <p className="text-center text-sm text-muted-foreground">
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
        <AuthField id="password" label="New password">
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

        <AuthField id="confirm-password" label="Confirm new password">
          <PasswordInput
            id="confirm-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Re-enter your new password"
            autoComplete="new-password"
            disabled={loading}
            minLength={6}
          />
        </AuthField>

        {loading && (
          <AuthMessage variant="loading">Updating password…</AuthMessage>
        )}
        {error && <AuthMessage variant="error">{error}</AuthMessage>}
        {success && <AuthMessage variant="success">{success}</AuthMessage>}

        <Button type="submit" className="w-full" size="lg" disabled={loading}>
          {loading ? "Updating password…" : "Update password"}
        </Button>
      </form>
    </AuthCard>
  );
}
