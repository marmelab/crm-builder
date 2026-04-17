// Supabase mode — real backend (Postgres + auth + storage).
// Requires `supabase start` to be running.
//
// To switch to FakeRest: switch-mode demo
import { CRM } from "@/components/atomic-crm/root/CRM";

const App = () => <CRM />;

export default App;
