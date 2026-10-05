'use strict'
// Tests des trames PGN 130850 "Simnet: AP Command" produites par lib/commands.js.
// Aucune dépendance externe : `node test/frames.test.js` (script `npm test`).
//
// On valide la STRUCTURE et les octets documentés (cf. PUBLISHING.md §2), pas les micro-variations
// d'angle d'un pupitre réel (0xAE vs 0xAF pour 1° selon la source) : commands.js utilise les valeurs
// validées 1°=0x00AE, 10°=0x06D1.

const assert = require('assert')
const cmds = require('../lib/commands')

const SA = '07' // adresse source (contrôleur actif) arbitraire pour les tests

// Décompose les 2 trames fast-packet en éléments comparables (en ignorant l'octet de séquence).
function parse (frames, sa) {
  assert.strictEqual(frames.length, 2, '2 trames attendues')
  const [id0, d0] = frames[0].split('#')
  const [id1, d1] = frames[1].split('#')
  assert.strictEqual(id0, '09FF22' + sa.toUpperCase(), 'ID trame 0')
  assert.strictEqual(id1, '09FF22' + sa.toUpperCase(), 'ID trame 1')
  return {
    head: d0.slice(2),         // 0C 41 9F <target> FF FF <class>
    payload: d1.slice(2, 14),  // P6..P11 (6 octets)
    tail: d1.slice(14)         // octet de padding
  }
}

let n = 0
function check (name, frames, { head, payload }) {
  const p = parse(frames, SA)
  assert.strictEqual(p.head, head, `${name}: entête`)
  assert.strictEqual(p.payload, payload, `${name}: payload P6..P11`)
  assert.strictEqual(p.tail, 'FF', `${name}: padding`)
  n++
  console.log(`  ok  ${name}`)
}

// --- Entête : cible AC42 par défaut (0x02) et override ---
check('changeCourse cible par défaut (0x02)',
  cmds.changeCourse(SA, 1, 'bear', 'Wind'),
  { head: '0C419F02FFFF0A', payload: '1A0002AE00FF' })

check('changeCourse cible override (0x0A)',
  cmds.changeCourse(SA, 1, 'bear', 'Wind', 0x0a),
  { head: '0C419F0AFFFF0A', payload: '1A0002AE00FF' })

// --- ChangeCourse : sens dépendant du mode ---
// Mode Vent : bear(+/abattre)=02, luff(−/lofer)=03
check('course Vent bear 1°', cmds.changeCourse(SA, 1, 'bear', 'Wind', 0x02),
  { head: '0C419F02FFFF0A', payload: '1A0002AE00FF' })
check('course Vent luff 1°', cmds.changeCourse(SA, 1, 'luff', 'Wind', 0x02),
  { head: '0C419F02FFFF0A', payload: '1A0003AE00FF' })
// Mode Cap/Auto : bear(+/tribord)=03, luff(−/bâbord)=02
check('course Cap bear 1°', cmds.changeCourse(SA, 1, 'bear', 'Auto', 0x02),
  { head: '0C419F02FFFF0A', payload: '1A0003AE00FF' })
check('course Cap luff 1°', cmds.changeCourse(SA, 1, 'luff', 'Auto', 0x02),
  { head: '0C419F02FFFF0A', payload: '1A0002AE00FF' })

// --- Angle : 1°=0x00AE, 10°=0x06D1 (little-endian) ---
check('course 10° (angle 06D1)', cmds.changeCourse(SA, 10, 'bear', 'Wind', 0x02),
  { head: '0C419F02FFFF0A', payload: '1A0002D106FF' })

// --- Modes ---
check('mode auto', cmds.mode(SA, 'auto', 0x02),
  { head: '0C419F02FFFF0A', payload: '0900FFFFFFFF' })
check('mode wind', cmds.mode(SA, 'wind', 0x02),
  { head: '0C419F02FFFF0A', payload: '0F0000000000' })
check('mode standby', cmds.mode(SA, 'standby', 0x02),
  { head: '0C419F02FFFF0A', payload: '060000000000' })

// --- Jeu de paramètres de barre : Bas forcé=08, Haut forcé=07, automatique=46 ---
check('response low', cmds.response(SA, 'low', 0x02),
  { head: '0C419F02FFFF0A', payload: '0800FFFFFFFF' })
check('response high', cmds.response(SA, 'high', 0x02),
  { head: '0C419F02FFFF0A', payload: '0700FFFFFFFF' })
check('response auto', cmds.response(SA, 'auto', 0x02),
  { head: '0C419F02FFFF0A', payload: '4600FFFFFFFF' })

// --- Tack : stbd=03, port=02 ---
check('tack stbd', cmds.tack(SA, 'stbd', 0x02),
  { head: '0C419F02FFFF0A', payload: '110003FFFFFF' })
check('tack port', cmds.tack(SA, 'port', 0x02),
  { head: '0C419F02FFFF0A', payload: '110002FFFFFF' })

// --- NFU (barre) : classe 0x02, stbd=05, port=04, stop=FF ---
check('rudder stbd (NFU)', cmds.rudder(SA, 'stbd', 0x02),
  { head: '0C419F02FFFF02', payload: '0D0005000000' })
check('rudder port (NFU)', cmds.rudder(SA, 'port', 0x02),
  { head: '0C419F02FFFF02', payload: '0D0004000000' })
check('rudder stop (NFU)', cmds.rudder(SA, 'stop', 0x02),
  { head: '0C419F02FFFF02', payload: '0D00FF000000' })

// --- Lecture d'un réglage (PGN 130845) : 3 trames, identiques à celles d'un Zeus3S ---
cmds._resetSeq()
assert.deepStrictEqual(cmds.keyQuery('06', cmds.KEY.responseLow, 0x02), [
  '0DFF1D06#200E419F02FFFFFF',
  '0DFF1D06#2119110000FFFFFF',
  '0DFF1D06#22FFFFFFFFFFFFFF'
], 'keyQuery responseLow')
n++
console.log('  ok  keyQuery responseLow')

// --- Décodage des niveaux de réponse reçus (écriture d'un MFD, réponse de l'AC42) ---
{
  const ControllerDetector = require('../lib/controller')
  const d = new ControllerDetector({})
  d._onKvData(Buffer.from('(1.0) can0 0DFF1D06#000E419F02FFFFFF\n(1.0) can0 0DFF1D06#0119110001'))
  d._onKvData(Buffer.from('02FFFFFF\n(1.0) can0 0DFF1D06#02FFFFFFFFFFFFFF\n'))
  assert.strictEqual(d.levels.low, 2, 'écriture MFD : niveau Bas = 2')
  d._onKvData(Buffer.from('(1.0) can0 09FF1D02#400E419F02FFFFFF\n(1.0) can0 09FF1D02#411A11000201FFFF\n(1.0) can0 09FF1D02#42FFFFFFFFFFFFFF\n'))
  assert.strictEqual(d.levels.high, 1, 'réponse AC42 : niveau Haut = 1')
  d._onKvData(Buffer.from('(1.0) can0 0DFF1D06#600E419F02FFFFFF\n(1.0) can0 0DFF1D06#611C110000FFFFFF\n(1.0) can0 0DFF1D06#62FFFFFFFFFFFFFF\n'))
  assert.strictEqual(d.levels.wind, null, 'une requête ne porte pas de valeur')
  d._onKvData(Buffer.from('(1.0) can0 09FF1D02#800E419F02FFFFFF\n(1.0) can0 09FF1D02#811A0D00027300FF\n(1.0) can0 09FF1D02#82FFFFFFFFFFFFFF\n'))
  assert.deepStrictEqual(d.levels, { low: 2, high: 1, wind: null }, 'autre clé ignorée')
  n++
  console.log('  ok  response levels decoding')
}

console.log(`\nAll ${n} frame tests passed.`)
