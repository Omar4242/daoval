import { VITALS_CONFIG } from '../../fhir/codes'

export default function VitalsSection({ value, onChange, onBlurAutosave }) {
  function set(key, v) {
    onChange({ [key]: v })
  }

  return (
    <div id="section-vitals" className="card section-anchor">
      <h3 style={{ marginBottom: 4 }}>Vitals</h3>
      <p className="hint" style={{ marginBottom: 14 }}>
        None are required. Out-of-plausible-range values are flagged for confirmation — they never block a save. A real
        patient can have a heart rate of 210.
      </p>
      <div className="field-grid">
        {VITALS_CONFIG.map((v) => {
          const raw = value[v.key]
          const num = raw === '' || raw == null ? null : Number(raw)
          const outOfRange = num != null && !Number.isNaN(num) && (num < v.min || num > v.max)
          return (
            <div key={v.key} className={`field ${outOfRange ? 'out-of-range' : ''}`}>
              <label>
                {v.label} <span className="mono hint">({v.unit})</span>
              </label>
              <input
                type="number"
                step="any"
                value={raw ?? ''}
                onChange={(e) => set(v.key, e.target.value)}
                onBlur={onBlurAutosave}
              />
              {outOfRange && <span className="warn-text">Outside plausible range ({v.min}–{v.max}) — confirm it's correct.</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
