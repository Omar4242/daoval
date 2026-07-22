import { SMOKING_STATUS_CODES, TYPEAHEAD_CVX } from '../../fhir/codes'
import CodeTypeahead from '../../components/CodeTypeahead'

const blankImm = { vaccine: null, adminDate: '' }

export default function PreventiveCareSection({ value, onChange }) {
  function set(patch) {
    onChange({ ...value, ...patch })
  }
  function addImm() {
    set({ immunizations: [...value.immunizations, { ...blankImm, _key: Date.now() }] })
  }
  function updateImm(i, patch) {
    set({ immunizations: value.immunizations.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) })
  }
  function removeImm(i) {
    set({ immunizations: value.immunizations.filter((_, idx) => idx !== i) })
  }

  return (
    <div id="section-preventive" className="card section-anchor">
      <h3 style={{ marginBottom: 14 }}>Preventive care &amp; social history</h3>

      <div className="field" style={{ marginBottom: 18, maxWidth: 320 }}>
        <label>Smoking status</label>
        <select
          value={value.smokingStatus?.code || ''}
          onChange={(e) => set({ smokingStatus: SMOKING_STATUS_CODES.find((s) => s.code === e.target.value) || null })}
        >
          <option value="">Select…</option>
          {SMOKING_STATUS_CODES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.display}
            </option>
          ))}
        </select>
      </div>

      <h3 style={{ margin: '10px 0' }}>Vaccinations administered today</h3>
      {value.immunizations.map((row, i) => {
        const dateInvalid = row.adminDate && new Date(row.adminDate) > new Date()
        return (
          <div key={row._key || i} className="card" style={{ background: 'var(--paper)', marginBottom: 10 }}>
            <div className="field-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Vaccine <span className="req">*</span></label>
                <CodeTypeahead options={TYPEAHEAD_CVX} value={row.vaccine} placeholder="Search CVX / SNOMED…" onSelect={(opt) => updateImm(i, { vaccine: opt })} />
              </div>
              <div className={`field ${dateInvalid ? 'invalid' : ''}`}>
                <label>Admin date <span className="req">*</span></label>
                <input type="date" max={new Date().toISOString().slice(0, 10)} value={row.adminDate} onChange={(e) => updateImm(i, { adminDate: e.target.value })} />
                {dateInvalid && <span className="err-text">Cannot be in the future.</span>}
              </div>
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 8, color: 'var(--danger)' }} onClick={() => removeImm(i)}>
              Remove
            </button>
          </div>
        )
      })}
      <button className="btn btn-secondary" onClick={addImm}>
        + Add vaccine
      </button>
    </div>
  )
}
