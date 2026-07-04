<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reddit Lead Finder - Project Rules

## Project Goal

Build a production-ready SaaS MVP for Reddit Lead Finder using Next.js, TypeScript, Tailwind CSS and Supabase.

Priority:
- Simplicity
- Maintainability
- Clean architecture
- Production quality

---

# Before Making Changes

ALWAYS:

- Explain the implementation plan first.
- Wait for user confirmation before modifying code.
- Never make assumptions.
- Ask questions if requirements are unclear.

---

# Scope

Only modify files related to the requested feature.

Do not refactor unrelated files.

Do not introduce unrelated improvements.

---

# Code Style

- Use TypeScript.
- Prefer functional React components.
- Keep components small.
- Keep functions readable.
- Use descriptive variable names.
- Avoid duplicate code.

---

# UI Rules

- Clean SaaS design.
- Minimal UI.
- Mobile responsive.
- Desktop first.
- Accessibility friendly.

Avoid unnecessary animations.

---

# Architecture

Prefer:

Components
→ Hooks
→ Services
→ Database

Keep business logic outside UI components whenever possible.

---

# Authentication

Authentication is already implemented.

Do not change authentication flow unless explicitly requested.

---

# Database

Never change database schema without confirmation.

Never delete tables.

Never delete policies.

Never delete migrations.

---

# Security

Never expose secrets.

Never hardcode API keys.

Always respect Row Level Security.

---

# Performance

Avoid unnecessary API calls.

Avoid unnecessary re-renders.

Keep components lightweight.

---

# Configuration

Do not hardcode limits unless instructed.

Prefer configuration over hardcoded values.

---

# Debugging

Before fixing a bug:

1. Investigate.
2. Explain root cause.
3. Propose solution.
4. Wait for approval.
5. Then implement.

Never blindly change multiple things.

---

# Git

Never run destructive git commands.

Never reset branches.

Never delete commits.

---

# Documentation

When adding major functionality,
briefly explain:

- What changed
- Why
- Files modified

---

# MVP Philosophy

Functionality first.

Polish later.

Avoid overengineering.

Build only what is necessary for MVP.

---

# Communication

Be concise.

Explain decisions.

Warn before risky changes.

Always wait for confirmation before making changes.

---

## Development Workflow

Always follow this order:

1. Investigate
2. Explain findings
3. Propose solution
4. Wait for approval
5. Implement
6. Verify results

Never skip these steps.

---

## Time Management

If debugging or investigation exceeds approximately 30–45 minutes without meaningful progress:

- Stop.
- Re-evaluate the root cause.
- Consider a simpler or alternative solution.
- Discuss options before continuing.

Avoid spending hours on one issue when a simpler solution exists.

