'use strict'
// Le ping quotidien « cette installation existe ». C'est la seule donnée que
// ce plugin envoie, et l'équipage n'y gagne rien directement — elle mérite
// donc d'être tenue plus court que le reste, pas moins.
//
// Ce que ce fichier vérifie surtout : que la charge utile ne peut pas grossir
// en douce, qu'un réglage coupé coupe vraiment, et qu'aucune donnée du pilote
// ou du bus ne s'y invite. `lib/usage.js` est une copie conforme de celui de
// signalk-autopolar ; ce test l'est aussi, aux champs près.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createUsage, isDue, DAY, RETRY_MS, MIN_UPTIME_MS } = require('../lib/usage')

const T0 = 1e12
const UP = MIN_UPTIME_MS // tourne depuis assez longtemps pour avoir le droit de parler

// ── La règle de déclenchement, nue ─────────────────────────────────────────
assert.strictEqual(isDue({ lastSentAt: T0, lastTry: T0 }, T0 + DAY - 1, DAY, UP), false, 'moins d\'un jour : rien')
assert.strictEqual(isDue({ lastSentAt: T0, lastTry: T0 }, T0 + DAY, DAY, UP), true, 'un jour plus tard : un ping')
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, 0, UP), false, 'période nulle = coupé')

// La première heure ne compte pas : une installation essayée cinq minutes puis
// retirée n'en est pas une, et un `npm test` n'en est pas une non plus.
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, DAY, 0), false, 'au démarrage : rien')
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, DAY, UP - 1), false, 'à 59 min : toujours rien')
assert.strictEqual(isDue({ lastSentAt: 0, lastTry: 0 }, T0, DAY, UP), true, 'passé l\'heure : le premier ping part')

// Après un échec on retente dans l'heure, sans marteler un lien mort.
const failed = { lastSentAt: 0, lastTry: T0, lastError: 'ENETUNREACH' }
assert.strictEqual(isDue(failed, T0 + 60000, DAY, UP), false, 'on ne martèle pas')
assert.strictEqual(isDue(failed, T0 + RETRY_MS + 1, DAY, UP), true, 'la reprise revient d\'elle-même')

// ── L'objet, avec un réseau bouchonné ──────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac42-usage-'))
const file = path.join(dir, 'usage.json')
const OPTS = { usageStats: true, usageEndpoint: 'https://collector.test/v1/ping' }

let posts = []
let fail = false
global.fetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) })
  if (fail) throw new Error('ENETUNREACH')
  return { ok: true, status: 200 }
}
const settle = () => new Promise((r) => setImmediate(r))

// La charge utile de référence : exactement ce qu'énumère la description de
// l'option `usageStats` dans index.js. Si ce test casse parce qu'un champ a
// été ajouté, ce n'est pas le test qu'il faut corriger — c'est la description,
// sinon on enverrait quelque chose qu'on n'a pas annoncé.
const ALLOWED = ['schema', 'plugin', 'installId', 'version', 'node', 'signalk', 'firstSeen']

const realNow = Date.now
let clock = realNow()
Date.now = () => clock
const runFor = (ms) => { clock += ms }

;(async () => {
  const u = createUsage(file, () => {})
  const id = u.id()
  assert.ok(/^[0-9a-f-]{36}$/.test(id), 'un identifiant est tiré au démarrage')

  // Reproduit usagePayload() d'index.js.
  const payload = () => ({
    schema: 1,
    plugin: 'signalk-ac42-autopilot',
    installId: u.id(),
    version: '9.9.9',
    node: process.version,
    signalk: '2.0.0',
    firstSeen: u.firstSeen()
  })

  assert.strictEqual(u.maybeSend(OPTS, payload), false, 'au démarrage, rien ne part')
  runFor(MIN_UPTIME_MS)
  assert.strictEqual(u.maybeSend(OPTS, payload), true, 'passé la première heure, le premier ping part')
  await settle()
  assert.strictEqual(posts.length, 1)
  assert.strictEqual(posts[0].url, OPTS.usageEndpoint)
  assert.deepStrictEqual(
    Object.keys(posts[0].body).sort(),
    ALLOWED.slice().sort(),
    'la charge utile est exactement celle qu\'annonce la configuration, pas un champ de plus'
  )
  assert.strictEqual(posts[0].body.plugin, 'signalk-ac42-autopilot', 'le collecteur doit pouvoir séparer les plugins')

  // Rien du pilote, rien du bus, rien du bateau — à aucun niveau.
  const flat = JSON.stringify(posts[0].body).toLowerCase()
  for (const forbidden of ['lat', 'lon', 'position', 'heading', 'rudder', 'wind', 'mode', 'address', 'can']) {
    assert.ok(!flat.includes(`"${forbidden}`), `aucun champ « ${forbidden} » dans le ping`)
  }

  // Une fois par jour, quoi qu'en dise la boucle des 5 minutes.
  for (let i = 0; i < 50; i++) u.maybeSend(OPTS, payload)
  await settle()
  assert.strictEqual(posts.length, 1, 'un seul ping par jour')

  // ── Coupé en configuration : rien, et pas même une tentative ─────────────
  posts = []
  const off = createUsage(path.join(dir, 'off.json'), () => {})
  runFor(MIN_UPTIME_MS)
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { usageStats: false }), payload), false)
  assert.strictEqual(off.maybeSend(Object.assign({}, OPTS, { usageEndpoint: '' }), payload), false, 'endpoint vide = coupé aussi')
  await settle()
  assert.strictEqual(posts.length, 0, 'réglage coupé : rien ne sort du bateau')

  // ── Un ping perdu est perdu ─────────────────────────────────────────────
  // Pas de file d'attente, délibérément : une statistique n'a pas le droit
  // d'être mieux traitée que ce qui sert vraiment l'équipage.
  posts = []
  fail = true
  const lost = createUsage(path.join(dir, 'lost.json'), () => {})
  runFor(MIN_UPTIME_MS)
  lost.maybeSend(OPTS, payload)
  await settle()
  assert.strictEqual(posts.length, 1)
  assert.ok(lost.state().lastError, 'l\'échec est visible')
  lost.maybeSend(OPTS, payload)
  await settle()
  assert.strictEqual(posts.length, 1, 'aucune file d\'attente, aucun rattrapage immédiat')

  // ── L'identifiant survit à un redémarrage ───────────────────────────────
  // Sinon chaque restart de SignalK compterait une installation de plus.
  fail = false
  const reopened = createUsage(file, () => {})
  assert.strictEqual(reopened.id(), id, 'le même identifiant est relu sur disque')
  assert.strictEqual(reopened.state().sent, 1, 'et le compteur avec')

  Date.now = realNow
  fs.rmSync(dir, { recursive: true, force: true })
  console.log('usage: ok')
})()
