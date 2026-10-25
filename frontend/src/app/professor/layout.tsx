import { RoleGate } from "@/components/app-shell";

export default function ProfessorLayout({ children }: { children: React.ReactNode }) {
  return <RoleGate role="PROFESSOR">{children}</RoleGate>;
}
