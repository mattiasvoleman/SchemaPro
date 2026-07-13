export default function GuardianLayout({ children }: { children: React.ReactNode }) {
  // Any authenticated role may view the guardian area; RLS scopes every read
  // to the caller's own children.
  return <>{children}</>;
}
