'use strict'
// Lecture du bus NMEA2000 pour :
//   1. détecter l'adresse source du contrôleur B&G actif (à utiliser comme SOURCE des commandes)
//   2. détecter l'adresse N2K du calculateur AC42 (à utiliser comme CIBLE des commandes + pour la lecture)
//   3. décoder le mode courant de l'AC42 (Vent / Auto / Standby / …) et la consigne de cap
//
// Autonome : ne dépend PAS du plugin signalk-autopilot. On lit can0 en parallèle de SignalK
// (SocketCAN autorise plusieurs lecteurs) via le pipeline canboat `candump | candump2analyzer
// | analyzer -json`, déjà présent sur les installs OpenPlotter/SignalK.
//
// Repères protocolaires (PGN 65305, propriétaire Simnet) :
//   - un contrôleur actif (pupitre/MFD) émet ~2 Hz : "Device Mode Request" / "Device Status Request"
//   - le calculateur AC42 publie son état : "Simnet: Pilot Mode" (champ Mode) et "Simnet: Device Status"
//     → son adresse N2K est DÉTECTÉE dynamiquement (= la src qui émet ces trames), pas figée à 2 :
//       elle varie d'un bateau à l'autre (address claim N2K).
//
// NB : la consigne d'angle au vent (mode Vent) n'est PAS reconstruite ici — SignalK la décode
// nativement (PGN 65341) dans le path steering.autopilot.target.windAngleApparent, lu directement
// par la web app.

const { spawn } = require('child_process')

const MODE_MAP = {
  standby: 'Standby',
  auto: 'Auto', automatic: 'Auto', heading: 'Auto', 'heading hold': 'Auto',
  wind: 'Wind', 'wind mode': 'Wind',
  'no drift': 'No Drift', nodrift: 'No Drift',
  nav: 'Nav', navigation: 'Nav', route: 'Nav'
}
const mapMode = (raw) => {
  if (raw == null) return null
  const s = String(typeof raw === 'object' ? (raw.name || raw.value || '') : raw)
  if (!s) return null
  return MODE_MAP[s.toLowerCase()] || (s.charAt(0).toUpperCase() + s.slice(1))
}
const h2 = (n) => n.toString(16).toUpperCase().padStart(2, '0')

class ControllerDetector {
  constructor (opts = {}) {
    this.iface = opts.iface || 'can0'
    this.staleMs = opts.staleMs || 5000
    this.log = opts.log || (() => {})
    this.lastSrc = null
    this.lastSeen = 0
    this.seen = new Map()
    this.mode = null
    this.rawMode = null
    this._engaged = null
    this.rawStatus = null
    this.target = null      // consigne de cap (deg True), PGN 127237 "Heading-To-Steer"
    this.apAddr = null      // adresse N2K de l'AC42, détectée (= src qui émet Pilot Mode/Device Status)
    // Override de config éventuel (hex, ex "02"). Si posé, prime sur la détection.
    this._apForced = null
    if (opts.apAddress != null && String(opts.apAddress).trim() !== '') {
      const n = parseInt(String(opts.apAddress).trim(), 16)
      if (!Number.isNaN(n)) this._apForced = n
    }
    this.proc = null
    this._buf = ''
    this._stopped = false
  }

  start () {
    if (this.proc) return
    this.proc = spawn('bash', ['-c',
      `candump ${this.iface} | candump2analyzer 2>/dev/null | analyzer -json 2>/dev/null`])
    this.proc.stdout.on('data', (b) => this._onData(b))
    this.proc.on('error', (e) => this.log(`bus reader error: ${e.message}`))
    this.proc.on('exit', (code) => {
      this.proc = null
      if (!this._stopped) { this.log(`bus reader exit (${code}), restart 2s`); setTimeout(() => this.start(), 2000) }
    })
    this.log(`lecture bus démarrée (${this.iface})`)
  }

  stop () { this._stopped = true; if (this.proc) { this.proc.kill(); this.proc = null } }

  // Adresse N2K effective de l'AC42 : forcée par config sinon détectée.
  _effAp () { return this._apForced != null ? this._apForced : this.apAddr }

  _onData (buf) {
    this._buf += buf.toString()
    let nl
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl); this._buf = this._buf.slice(nl + 1)
      if (line.indexOf('65305') < 0 && line.indexOf('127237') < 0) continue
      try {
        const o = JSON.parse(line)
        const now = Date.now()
        const f = o.fields || {}
        const d = o.description || ''
        if (o.pgn === 127237) { // Heading/Track control : consigne de cap (émise par l'AC42)
          const ap = this._effAp()
          if (ap == null || o.src === ap) {
            const h = f['Heading-To-Steer (Course)']
            if (typeof h === 'number') this.target = h
          }
          continue
        }
        if (o.pgn !== 65305) continue
        // ⚠️ Tester "Request" EN PREMIER : "Device Status Request" (émis par un pupitre) contient
        // la sous-chaîne "Device Status" → sinon on prendrait le pupitre pour l'AC42.
        if (d.indexOf('Request') >= 0) { // heartbeat d'un contrôleur actif (Device Mode/Status Request)
          const src = h2(o.src); this.seen.set(src, now); this.lastSrc = src; this.lastSeen = now
        } else if (d.indexOf('Pilot Mode') >= 0 || d.indexOf('Device Status') >= 0) {
          // trames d'état du calculateur AC42 → on détecte dynamiquement son adresse N2K
          this.apAddr = o.src
          if (d.indexOf('Pilot Mode') >= 0 && Array.isArray(f.Mode)) {
            const label = f.Mode[f.Mode.length - 1] // ex [2,4,"Heading"] -> "Heading"
            const m = mapMode(label)
            if (m) { this.rawMode = label; this.mode = m }
          } else if (d.indexOf('Device Status') >= 0 && f.Status != null) {
            this.rawStatus = f.Status
            this._engaged = String(f.Status).toLowerCase() === 'automatic'
          }
        }
      } catch (e) { /* ligne non-JSON ou champ inattendu : on ignore */ }
    }
  }

  active () {
    if (this.lastSrc && Date.now() - this.lastSeen < this.staleMs) return this.lastSrc
    return null
  }

  activeList () {
    const now = Date.now()
    return [...this.seen.entries()].filter(([, t]) => now - t < this.staleMs).map(([s]) => s)
  }

  currentMode () { return this.mode }
  currentTarget () { return this.target }
  // Adresse N2K de l'AC42 (nombre) : cible des commandes. null tant qu'elle n'est pas connue.
  apAddress () { return this._effAp() }
  // Étiquette de source SignalK correspondante (ex "can0.2"), pour filtrer les données du pilote côté web app.
  apSource () { const a = this._effAp(); return a == null ? null : `${this.iface}.${a}` }
  engaged () {
    if (this._engaged != null) return this._engaged
    return this.mode != null && this.mode !== 'Standby'
  }
}

module.exports = ControllerDetector
