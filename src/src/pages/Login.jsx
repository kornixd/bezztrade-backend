import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { API } from '../main.jsx'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleLogin = async () => {
    if (!email || !password) { setError('Please fill in all fields'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      if (data.success) {
        localStorage.setItem('token', data.token)
        localStorage.setItem('user', JSON.stringify(data.user))
        navigate('/')
      } else {
        setError(data.error || 'Login failed')
      }
    } catch (err) {
      setError('Connection failed. Please try again.')
    }
    setLoading(false)
  }

  return (
    <div style={s.container}>
      <div style={s.logoSection}>
        <div style={s.logo}>BezzTrade</div>
        <div style={s.tagline}>Trade · Earn · Grow</div>
      </div>
      <div style={s.card}>
        <div style={s.tabs}>
          <div style={s.activeTab}>Login</div>
          <Link to="/register" style={s.inactiveTab}>Register</Link>
        </div>
        {error && <div style={s.error}>{error}</div>}
        <div style={s.inputGroup}>
          <label style={s.label}>Email</label>
          <input style={s.input} type="email" placeholder="Enter your email"
            value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div style={s.inputGroup}>
          <label style={s.label}>Password</label>
          <input style={s.input} type="password" placeholder="Enter your password"
            value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        <button style={loading ? s.btnDisabled : s.btn} onClick={handleLogin} disabled={loading}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        <div style={s.footer}>
          Don't have an account? <Link to="/register" style={s.link}>Register</Link>
        </div>
      </div>
    </div>
  )
}

const s = {
  container: { minHeight: '100vh', background: '#0a0b0f', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px' },
  logoSection: { textAlign: 'center', marginBottom: '40px' },
  logo: { fontSize: '36px', fontWeight: '800', color: '#f0b90b' },
  tagline: { color: '#8a8f9b', fontSize: '14px', marginTop: '8px' },
  card: { background: '#161920', borderRadius: '20px', padding: '24px', width: '100%', maxWidth: '390px' },
  tabs: { display: 'flex', background: '#0a0b0f', borderRadius: '12px', padding: '4px', marginBottom: '24px' },
  activeTab: { flex: 1, background: '#f0b90b', color: '#0a0b0f', fontWeight: '700', fontSize: '15px', padding: '10px', borderRadius: '10px', textAlign: 'center' },
  inactiveTab: { flex: 1, color: '#8a8f9b', fontSize: '15px', padding: '10px', textAlign: 'center', textDecoration: 'none' },
  error: { background: '#2d1515', border: '1px solid #f6465d', color: '#f6465d', padding: '12px', borderRadius: '10px', fontSize: '14px', marginBottom: '16px' },
  inputGroup: { marginBottom: '16px' },
  label: { color: '#8a8f9b', fontSize: '13px', marginBottom: '8px', display: 'block' },
  input: { width: '100%', background: '#0a0b0f', border: '1px solid #2a2d3e', borderRadius: '12px', padding: '14px 16px', color: 'white', fontSize: '15px', outline: 'none', boxSizing: 'border-box' },
  btn: { width: '100%', background: '#f0b90b', color: '#0a0b0f', fontWeight: '700', fontSize: '16px', padding: '16px', borderRadius: '12px', border: 'none', cursor: 'pointer', marginTop: '8px' },
  btnDisabled: { width: '100%', background: '#4a4f5e', color: '#8a8f9b', fontWeight: '700', fontSize: '16px', padding: '16px', borderRadius: '12px', border: 'none', cursor: 'not-allowed', marginTop: '8px' },
  footer: { textAlign: 'center', color: '#8a8f9b', fontSize: '14px', marginTop: '20px' },
  link: { color: '#f0b90b', textDecoration: 'none', fontWeight: '600' }
}
