import { ConnectAccounts } from '../../components/ConnectAccounts';

/** The Dashboard: your accounts and their status. System status is in Settings. */
export function DashboardPage() {
  return (
    <div className="stack">
      <ConnectAccounts />
    </div>
  );
}
