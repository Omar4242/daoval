export default function ExamSection({ value, onChange, onBlurAutosave }) {
  return (
    <div id="section-exam" className="card section-anchor">
      <h3 style={{ marginBottom: 14 }}>Exam findings</h3>
      <div className="field">
        <label>Exam notes</label>
        <textarea
          rows={6}
          maxLength={3000}
          placeholder="Free text — stays unstructured for this version by design."
          value={value.notes || ''}
          onChange={(e) => onChange({ notes: e.target.value })}
          onBlur={onBlurAutosave}
        />
        <span className="hint">{value.notes?.length || 0}/3000</span>
      </div>
    </div>
  )
}
