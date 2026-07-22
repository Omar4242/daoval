import { useEffect, useState } from 'react'
import { onSyncStatusChange, currentStatus, checkConnectivity } from '../services/dataService'

export default function SyncStatus() {
  const [status, setStatus] = useState(currentStatus())

  useEffect(() => {
    checkConnectivity()
    return onSyncStatusChange(setStatus)
  }, [])

  const dotClass = !status.online ? 'offline' : status.pending > 0 ? 'pending' : ''
  const label = !status.online
    ? status.pending > 0
      ? `Offline · ${status.pending} queued`
      : 'Offline · saved locally'
    : status.pending > 0
    ? `Syncing ${status.pending}…`
    : 'Synced to server'

  return (
    <div className="sync-pill" title="Connection to the HAPI FHIR server">
      <span className={`sync-dot ${dotClass}`} />
      {label}
    </div>
  )
}
