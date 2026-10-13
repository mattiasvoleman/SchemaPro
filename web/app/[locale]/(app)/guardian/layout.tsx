export default function GuardianLayout({ children }: { children: React.ReactNode }) {
  // Any authenticated role may view the guardian area; every read is scoped
  // to the caller's own children, whether the gateway answers it
  // (lib/guardian-queries.ts) or RLS does.
  return <>{children}</>;
}
