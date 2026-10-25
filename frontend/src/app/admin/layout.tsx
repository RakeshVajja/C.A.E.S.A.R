import { RoleGate } from "@/components/app-shell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <RoleGate role="ADMIN">{children}</RoleGate>;
}
