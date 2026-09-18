import CrmShell from '../../components/CrmShell';

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return <CrmShell>{children}</CrmShell>;
}
