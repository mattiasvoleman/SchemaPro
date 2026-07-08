export default function StudentLayout({ children }: { children: React.ReactNode }) {
  // Any authenticated role may view the student area (admins/teachers see
  // their own schedule views elsewhere; RLS scopes all student data reads).
  return <>{children}</>;
}
