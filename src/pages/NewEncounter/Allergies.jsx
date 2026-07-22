import { ALLERGY_CRITICALITY, ALLERGY_VERIFICATION, TYPEAHEAD_SNOMED_ALLERGEN } from '../../fhir/codes'
import CodeTypeahead from '../../components/CodeTypeahead'

const blank = { substance: null, criticality: '', reaction: '', verificationStatus: '' }

export default function AllergiesSection({ value, onChange }) {
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
    <div id="section-allergies" className="card section-anchor">
      <h3 style={{ marginBottom: 4 }}>Allergies &amp; Intolerances</h3>
      <p className="hint" style={{ marginBottom: 14 }}>Add zero or more. Each becomes its own AllergyIntolerance resource.</p>

      {value.length === 0 && <p className="hint" style={{ marginBottom: 12 }}>No known allergies documented yet.</p>}

      {value.map((row, i) => {
        const incomplete = row.substance && (!row.criticality || !row.verificationStatus)
        return (
          <div key={row._key || i} className="card" style={{ background: 'var(--paper)', marginBottom: 10 }}>
            <div className="field-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Substance / drug <span className="req">*</span></label>
                <CodeTypeahead
                  options={TYPEAHEAD_SNOMED_ALLERGEN}
                  value={row.substance}
                  placeholder="Search SNOMED / RxNorm…"
                  onSelect={(opt) => updateRow(i, { substance: opt })}
                />
              </div>
              <div className="field">
                <label>Criticality <span className="req">*</span></label>
                <select value={row.criticality} onChange={(e) => updateRow(i, { criticality: e.target.value })}>
                  <option value="">Select…</option>
                  {ALLERGY_CRITICALITY.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.display}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Verification status <span className="req">*</span></label>
                <select value={row.verificationStatus} onChange={(e) => updateRow(i, { verificationStatus: e.target.value })}>
                  <option value="">Select…</option>
                  {ALLERGY_VERIFICATION.map((v) => (
                    <option key={v.code} value={v.code}>
                      {v.display}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Reaction</label>
                <input type="text" maxLength={500} value={row.reaction} onChange={(e) => updateRow(i, { reaction: e.target.value })} />
              </div>
            </div>
            {incomplete && <p className="err-text" style={{ marginTop: 8 }}>Criticality and verification status are required for this row.</p>}
            <button className="btn btn-ghost" style={{ marginTop: 8, color: 'var(--danger)' }} onClick={() => removeRow(i)}>
              Remove
            </button>
          </div>
        )
      })}
      <button className="btn btn-secondary" onClick={addRow}>
        + Add allergy
      </button>
    </div>
  )
}
