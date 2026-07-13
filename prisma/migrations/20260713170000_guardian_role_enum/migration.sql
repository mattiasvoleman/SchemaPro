-- New application role for guardians (vårdnadshavare). Kept in its own
-- migration: PostgreSQL forbids using a new enum value in the same
-- transaction that adds it, and Prisma wraps each migration in one.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'GUARDIAN';
