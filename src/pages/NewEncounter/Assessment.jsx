import { CONDITION_CLINICAL_STATUS, TYPEAHEAD_ICD10 } from '../../fhir/codes'
import CodeTypeahead from '../../components/CodeTypeahead'

const blank = { diagnosis: null, clinicalStatus: 'active' }

export default function AssessmentSection({ value, onChange }) {
  function addRow() {
    onChange([...value, { ...blank, _key: Date.now() }])
  }
  function updateRow(i, patch) {
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function removeRow(i) {
    onChange(value.filter((_, idx) => idx !== i))
  }

  return (
    <div id="section-assessment" className="card section-anchor">
      <h3 style={{ marginBottom: 4 }}>Assessment</h3>
      <p className="hint" style={{ marginBottom: 14 }}>
        At least one diagnosis is required, resolving to a valid ICD-10-CM code.
      </p>

      {value.length === 0 && <p className="err-text" style={{ marginBottom: 12 }}>No diagnosis added yet.</p>}

      {value.map((row, i) => (
        <div key={row._key || i} className="card" style={{ background: 'var(--paper)', marginBottom: 10 }}>
          <div className="field-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Diagnosis <span className="req">*</span></label>
              <CodeTypeahead options={TYPEAHEAD_ICD10} value={row.diagnosis} placeholder="Search ICD-10-CM…" onSelect={(opt) => updateRow(i, { diagnosis: opt })} />
            </div>
            <div className="field">
              <label>Clinical status <span className="req">*</span></label>
              <select value={row.clinicalStatus} onChange={(e) => updateRow(i, { clinicalStatus: e.target.value })}>
                {CONDITION_CLINICAL_STATUS.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.display}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 8, color: 'var(--danger)' }} onClick={() => removeRow(i)}>
            Remove
          </button>
        </div>
      ))}
      <button className="btn btn-secondary" onClick={addRow}>
        + Add diagnosis
      </button>
    </div>
  )
}
