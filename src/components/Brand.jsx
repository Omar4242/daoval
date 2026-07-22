// Single source of truth for the Daoval wordmark/logo, used in every page's topbar
// and on the landing page. Previously "Daoval <small>LABEL</small>" was hand-typed in
// 11 different files — now it's one component, so a rebrand or logo swap is a
// one-file change instead of a find-and-replace across the app.

import logoMark from '../assets/logo-mark.png'

export default function Brand({ label, size = 'default' }) {
  return (
    <div className={`brand${size === 'large' ? ' brand-lg' : ''}`}>
      <img src={logoMark} alt="" className="brand-logo" />
      <span className="brand-word">
        Daoval {label && <small>{label}</small>}
      </span>
    </div>
  )
}
