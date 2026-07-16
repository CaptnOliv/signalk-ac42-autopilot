'use strict'
// Plugin SignalK : contrôle du pilote automatique Simrad AC42 via NMEA2000.
//
// Deux briques : (1) détection continue de l'adresse du contrôleur B&G actif,
// (2) émission des commandes 130850 depuis CETTE adresse. Sert aussi une web app mobile
// et une petite API REST sous /plugins/signalk-ac42-autopilot/.

const ControllerDetector = require('./lib/controller')
const cmds = require('./lib/commands')
const { sendFrames } = require('./lib/cansend')

module.exports = function (app) {
  let detector = null
  let iface = 'can0'

  const plugin = {
    id: 'signalk-ac42-autopilot',
    name: 'Simrad AC42 Autopilot',
    description: 'Control a Simrad AC42 autopilot over NMEA 2000, with a mobile web app.'
  }

  plugin.schema = {
    type: 'object',
    properties: {
      canInterface: {
        type: 'string',
        title: 'CAN interface',
        description: 'SocketCAN interface connected to the NMEA 2000 bus.',
        default: 'can0'
      },
      fixedControllerAddress: {
        type: 'string',
        title: 'Controller address override (advanced)',
        description: 'Force the source address used to send commands (hex, e.g. "07"). Leave empty for automatic detection of the active B&G controller.',
        default: ''
      },
      apAddress: {
        type: 'string',
        title: 'Autopilot (AC42) address override (advanced)',
        description: 'Force the NMEA 2000 address of the AC42 computer (hex, e.g. "02"). Leave empty for automatic detection (recommended).',
        default: ''
      },
      windDirectionSource: {
        type: 'string',
        title: 'True wind direction source (advanced)',
        description: 'SignalK $source to use for the TWD graph (e.g. "can0.2"). Leave empty to use the autopilot\'s own source when detected, otherwise any source.',
        default: ''
      },
      staleMs: {
        type: 'number',
        title: 'Controller timeout (ms)',
        description: 'How long a detected controller address stays valid without a new heartbeat.',
        default: 5000
      }
    }
  }

  // Adresse source à utiliser : forcée en config, sinon détectée, sinon erreur.
  function resolveSrc (options) {
    const forced = (options.fixedControllerAddress || '').trim()
    if (forced) return forced.toUpperCase().padStart(2, '0')
    const active = detector && detector.active()
    if (active) return active
    return null
  }

  // Adresse N2K cible (le calculateur AC42), pour les trames de commande. 0x02 par défaut si inconnue.
  function apTarget () {
    const a = detector && detector.apAddress()
    return (a == null) ? 0x02 : a
  }

  plugin.start = function (options) {
    iface = options.canInterface || 'can0'
    detector = new ControllerDetector({
      iface,
      staleMs: options.staleMs || 5000,
      apAddress: options.apAddress, // override éventuel de l'adresse N2K de l'AC42
      log: (m) => app.debug(m)
    })
    detector.start()
    plugin._options = options
    app.setPluginStatus('Started — detecting AC42 controller…')
    app.debug('AC42 plugin started')
  }

  plugin.stop = function () {
    if (detector) { detector.stop(); detector = null }
    app.setPluginStatus('Stopped')
  }

  // --- API REST (la web app est servie par le mécanisme webapp de SignalK, à /signalk-ac42-autopilot/) ---
  plugin.registerWithRouter = function (router) {
    // État courant : mode/adresse contrôleur, pour la web app.
    router.get('/status', (req, res) => {
      res.json({
        iface,
        activeController: detector ? detector.active() : null,
        controllersSeen: detector ? detector.activeList() : [],
        mode: detector ? detector.currentMode() : null,
        engaged: detector ? detector.engaged() : null,
        target: detector ? detector.currentTarget() : null,
        apAddress: detector ? detector.apAddress() : null,
        apSource: detector ? detector.apSource() : null,
        // Source à utiliser pour le graphe TWD : forcée en config, sinon celle du pilote détecté (sinon: aucune → toute source).
        twdSource: (plugin._options.windDirectionSource || '').trim() || (detector ? detector.apSource() : null),
        forced: (plugin._options.fixedControllerAddress || '').trim() || null
      })
    })

    // Changement de cap : POST /course  { dir: "bear"|"luff", deg: 1|10 }
    router.post('/course', async (req, res) => {
      const { dir, deg } = req.body || {}
      if (!['bear', 'luff'].includes(dir)) return res.status(400).json({ error: 'dir must be bear|luff' })
      const d = Number(deg)
      if (!(d > 0 && d <= 10)) return res.status(400).json({ error: 'deg must be within ]0, 10]' })
      const src = resolveSrc(plugin._options)
      if (!src) return res.status(409).json({ error: 'No active AC42 controller detected on the bus' })
      try {
        const frames = cmds.changeCourse(src, d, dir, detector.currentMode(), apTarget())
        await sendFrames(iface, frames)
        app.debug(`course ${dir} ${d}° (${detector.currentMode()}) via src ${src}: ${frames.join(' , ')}`)
        res.json({ ok: true, src, dir, deg: d, frames })
      } catch (e) {
        res.status(500).json({ error: e.message })
      }
    })

    // Changement de mode : POST /mode { mode: "auto"|"wind"|"standby" }
    router.post('/mode', async (req, res) => {
      const { mode } = req.body || {}
      if (!['auto', 'wind', 'standby'].includes(mode)) return res.status(400).json({ error: 'mode must be auto|wind|standby' })
      const src = resolveSrc(plugin._options)
      if (!src) return res.status(409).json({ error: 'No active AC42 controller detected on the bus' })
      try {
        const frames = cmds.mode(src, mode, apTarget())
        await sendFrames(iface, frames)
        app.debug(`mode ${mode} via src ${src}`)
        res.json({ ok: true, src, mode })
      } catch (e) { res.status(500).json({ error: e.message }) }
    })

    // Virement : POST /tack { dir: "port"|"stbd" }
    router.post('/tack', async (req, res) => {
      const { dir } = req.body || {}
      if (!['port', 'stbd'].includes(dir)) return res.status(400).json({ error: 'dir must be port|stbd' })
      const src = resolveSrc(plugin._options)
      if (!src) return res.status(409).json({ error: 'No active AC42 controller detected on the bus' })
      try {
        const frames = cmds.tack(src, dir, apTarget())
        await sendFrames(iface, frames)
        app.debug(`tack ${dir} via src ${src}`)
        res.json({ ok: true, src, dir })
      } catch (e) { res.status(500).json({ error: e.message }) }
    })

    // Barre directe Non-Follow-Up : POST /rudder { dir: "port"|"stbd"|"stop" }
    // 'port'/'stbd' fait bouger la barre en continu ; 'stop' l'arrête. À maintenir/relâcher côté client.
    router.post('/rudder', async (req, res) => {
      const { dir } = req.body || {}
      if (!['port', 'stbd', 'stop'].includes(dir)) return res.status(400).json({ error: 'dir must be port|stbd|stop' })
      const src = resolveSrc(plugin._options)
      if (!src) return res.status(409).json({ error: 'No active AC42 controller detected on the bus' })
      try {
        await sendFrames(iface, cmds.rudder(src, dir, apTarget()))
        res.json({ ok: true, src, dir })
      } catch (e) { res.status(500).json({ error: e.message }) }
    })

  }

  return plugin
}
