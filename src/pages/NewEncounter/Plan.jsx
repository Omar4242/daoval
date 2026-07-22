import { MEDICATION_FREQUENCY, TYPEAHEAD_RXNORM } from '../../fhir/codes'
import CodeTypeahead from '../../components/CodeTypeahead'

const blankMed = { drug: null, dose: '', unit: 'mg', frequency: '', duration: '' }

export default function PlanSection({ value, onChange, onBlurAutosave }) {
  function set(patch) {
    onChange({ ...value, ...patch })
  }
  function addMed() {
    set({ medications: [...value.medications, { ...blankMed, _key: Date.now() }] })
  }
  function updateMed(i, patch) {
    set({ medications: value.medications.map((m, idx) => (idx === i ? { ...m, ...patch } : m)) })
  }
  function removeMed(i) {
    set({ medications: value.medications.filter((_, idx) => idx !== i) })
  }
  function addFiles(fileList) {
    const files = Array.from(fileList)
    const accepted = files.filter((f) => ['application/pdf', 'image/jpeg', 'image/png'].includes(f.type) && f.size <= 10 * 1024 * 1024)
    const rejected = files.length - accepted.length
    set({
      attachments: [...value.attachments, ...accepted.map((f) => ({ name: f.name, size: f.size, type: f.type }))],
    })
    if (rejected > 0) alert(`${rejected} file(s) rejected — PDF/JPG/PNG only, 10 MB max.`)
  }

  return (
    <div id="section-plan" className="card section-anchor">
      <h3 style={{ marginBottom: 4 }}>Plan</h3>
      <p className="hint" style={{ marginBottom: 14 }}>Medications are only required if you're prescribing.</p>

      {value.medications.map((m, i) => {
        const doseInvalid = m.dose !== '' && Number(m.dose) <= 0
        const durationInvalid = m.duration !== '' && (!Number.isInteger(Number(m.duration)) || Number(m.duration) <= 0)
        return (
          <div key={m._key || i} className="card" style={{ background: 'var(--paper)', marginBottom: 10 }}>
            <div className="field-grid">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Drug <span className="req">*</span></label>
                <CodeTypeahead options={TYPEAHEAD_RXNORM} value={m.drug} placeholder="Search RxNorm…" onSelect={(opt) => updateMed(i, { drug: opt })} />
              </div>
              <div className={`field ${doseInvalid ? 'invalid' : ''}`}>
                <label>Dose <span className="req">*</span></label>
                <input type="number" min="0" step="any" value={m.dose} onChange={(e) => updateMed(i, { dose: e.target.value })} onBlur={onBlurAutosave} />
                {doseInvalid && <span className="err-text">Dose must be greater than 0.</span>}
              </div>
              <div className="field">
                <label>Unit <span className="req">*</span></label>
                <select value={m.unit} onChange={(e) => updateMed(i, { unit: e.target.value })}>
                  <option value="mg">mg</option>
                  <option value="ml">ml</option>
                  <option value="tablet">tablet</option>
                  <option value="drop">drop</option>
                </select>
              </div>
              <div className="field">
                <label>Frequency <span className="req">*</span></label>
                <select value={m.frequency} onChange={(e) => updateMed(i, { frequency: e.target.value })}>
                  <option value="">Select…</option>
                  {MEDICATION_FREQUENCY.map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.display}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`field ${durationInvalid ? 'invalid' : ''}`}>
                <label>Duration (days) <span className="req">*</span></label>
                <input type="number" min="1" step="1" value={m.duration} onChange={(e) => updateMed(i, { duration: e.target.value })} onBlur={onBlurAutosave} />
                {durationInvalid && <span className="err-text">Whole number of days, greater than 0.</span>}
              </div>
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 8, color: 'var(--danger)' }} onClick={() => removeMed(i)}>
              Remove
            </button>
          </div>
        )
      })}
      <button className="btn btn-secondary" onClick={addMed} style={{ marginBottom: 20 }}>
        + Add medication
      </button>

      <div className="field-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Follow-up instructions</label>
          <textarea rows={3} maxLength={1000} value={value.followUpInstructions} onChange={(e) => set({ followUpInstructions: e.target.value })} onBlur={onBlurAutosave} />
        </div>
        <div className="field">
          <label>Follow-up date</label>
          <input
            type="date"
            min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
            value={value.followUpDate}
            onChange={(e) => set({ followUpDate: e.target.value })}
            onBlur={onBlurAutosave}
          />
          <span className="hint">Must be a future date.</span>
        </div>
        <div className="field">
          <label>Attachments</label>
          <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => addFiles(e.target.files)} />
          <span className="hint">PDF, JPG, PNG · 10 MB max per file</span>
        </div>
      </div>
      {value.attachments.length > 0 && (
        <ul style={{ marginTop: 10, fontSize: 13 }}>
          {value.attachments.map((f, i) => (
            <li key={i} className="mono">
              {f.name} ({Math.round(f.size / 1024)} KB)
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
