export default function HistorySection({ value, onChange, onBlurAutosave }) {
  const ccLen = value.chiefComplaint?.length || 0
  const ccInvalid = ccLen > 0 && (ccLen < 3 || ccLen > 500)

  return (
    <div id="section-history" className="card section-anchor">
      <h3 style={{ marginBottom: 14 }}>History</h3>
      <div className={`field ${ccInvalid ? 'invalid' : ''}`} style={{ marginBottom: 14 }}>
        <label>Chief complaint <span className="req">*</span></label>
        <textarea
          rows={2}
          maxLength={500}
          value={value.chiefComplaint || ''}
          onChange={(e) => onChange({ chiefComplaint: e.target.value })}
          onBlur={onBlurAutosave}
        />
        <span className={ccInvalid ? 'err-text' : 'hint'}>{ccLen}/500 · 3–500 characters</span>
      </div>
      <div className="field">
        <label>History of present illness</label>
        <textarea
          rows={5}
          maxLength={3000}
          value={value.hpi || ''}
          onChange={(e) => onChange({ hpi: e.target.value })}
          onBlur={onBlurAutosave}
        />
        <span className="hint">{value.hpi?.length || 0}/3000</span>
      </div>
    </div>
  )
}
