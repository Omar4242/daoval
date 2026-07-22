import { useState, useRef, useEffect } from 'react'

/** options: [{code, display}]. onSelect receives the chosen option. value: currently selected option or null. */
export default function CodeTypeahead({ options, value, onSelect, placeholder, allowFreeText, onFreeText }) {
  const [query, setQuery] = useState(value?.display || '')
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    setQuery(value?.display || '')
  }, [value])

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const matches =
    query.length >= 2
      ? options.filter(
          (o) => o.display.toLowerCase().includes(query.toLowerCase()) || o.code.toLowerCase().includes(query.toLowerCase())
        )
      : []

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <input
        type="text"
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (allowFreeText) onFreeText?.(e.target.value)
        }}
        onFocus={() => setOpen(true)}
      />
      {open && query.length >= 2 && matches.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--surface)',
            border: '1px solid var(--line-strong)',
            borderRadius: 4,
            marginTop: 3,
            zIndex: 20,
            padding: '8px 10px',
            fontSize: 12.5,
            color: 'var(--ink-soft)',
          }}
        >
          No matches for &ldquo;{query}&rdquo; in this sample code list — try a different term.
        </div>
      )}
      {open && matches.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--surface)',
            border: '1px solid var(--line-strong)',
            borderRadius: 4,
            marginTop: 3,
            zIndex: 20,
            maxHeight: 220,
            overflowY: 'auto',
            boxShadow: 'var(--shadow-2)',
          }}
        >
          {matches.map((o) => (
            <div
              key={o.code}
              onClick={() => {
                onSelect(o)
                setQuery(o.display)
                setOpen(false)
              }}
              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13.5, borderBottom: '1px solid var(--line)' }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="mono" style={{ color: 'var(--primary)', marginRight: 8 }}>
                {o.code}
              </span>
              {o.display}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
