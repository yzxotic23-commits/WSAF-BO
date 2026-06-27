import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Accounts from './pages/Accounts'
import Nurturing from './pages/Nurturing'
import IPs from './pages/IPs'
import IPAudit from './pages/IPAudit'
import Devices from './pages/Devices'
import SIMs from './pages/SIMs'
import WorkOrders from './pages/WorkOrders'
import Portal from './pages/Portal'
import Dashboard from './pages/Dashboard'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/accounts" replace />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/nurturing" element={<Nurturing />} />
        <Route path="/ips" element={<IPs />} />
        <Route path="/ip-audit" element={<IPAudit />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/sims" element={<SIMs />} />
        <Route path="/workorders" element={<WorkOrders />} />
        <Route path="/portal" element={<Portal />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </Layout>
  )
}
