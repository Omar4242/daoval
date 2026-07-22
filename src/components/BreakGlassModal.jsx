import { useState } from 'react'

export default function BreakGlassModal({ patientName, onConfirm, onCancel }) {
  const [reason, setReason] = useState('')

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Break-glass access</h2>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>
          {patientName} isn't on your active schedule or recent care list. State a reason for access — this is recorded
          to the audit log.
        </p>
        <div className="field" style={{ marginBottom: 14 }}>
          <label>Reason for access <span className="req">*</span></label>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>
            Confirm & open chart
          </button>
        </div>
      </div>
    </div>
  )
}
