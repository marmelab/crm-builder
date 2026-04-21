// FakeRest mode — API simulated in the browser, no backend required.
// Data is auto-generated and resets on every page reload.
// Use this for fast UI development without Supabase.
//
// To switch to Supabase: switch-mode full
import { CRM } from "@/components/atomic-crm/root/CRM";
import {
  dataProvider,
  authProvider,
} from "@/components/atomic-crm/providers/fakerest";

const App = () => (
  <CRM dataProvider={dataProvider} authProvider={authProvider} />
);

export default App;
