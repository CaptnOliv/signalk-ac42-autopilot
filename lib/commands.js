'use strict'
// Construction des trames NMEA2000 PGN 130850 "Simnet: AP Command" pour le Simrad AC42.
//
// Payload 12 octets (validé au bit près contre les trames réelles d'un pupitre B&G) :
//   41 9F 02 FF FF 0A [event] 00 [dir] [angLo angHi] FF
//     41 9F      = Manufacturer 1857 (Simrad) + Industry 4 (Marine)
//     02         = adresse cible = le calculateur AC42
//     0A         = command type (AP Command)
//     event      = 1A ChangeCourse | 06 Standby | ... (modes à capturer au mouillage)
//     dir        = 02 abattre (+, tribord de la cible vent) | 03 lofer (-)
//     angLo/Hi   = angle en 0.0001 rad, little-endian (1° validé = 0x00AE = 174)
//
// La commande part en fast-packet (2 trames CAN). On gère un compteur de séquence roulant.
// IMPORTANT : la trame doit être émise avec la SOURCE ADDRESS du contrôleur B&G actif
// (voir lib/controller.js) — c'est LA condition pour que l'AC42 obéisse.

// Events du PGN 130850 (octet P6), capturés depuis un pupitre B&G réel :
const EVENT = {
  changeCourse: 0x1a, // + dir + angle
  auto: 0x09,         // maintien de cap (Heading hold)
  wind: 0x0f,         // maintien d'angle au vent
  standby: 0x06,      // débrayage
  tack: 0x11          // virement, + dir
}

// Sens (octet P8). Confirmé au test 2026-07-15 : 0x02 = bâbord, 0x03 = tribord
// (identique pour ChangeCourse et Tack).
const DIR = {
  bear: 0x03, // + / tribord
  luff: 0x02  // - / bâbord
}

// Angle en 0.0001 rad/bit, little-endian. Valeurs VALIDÉES contre les trames réelles :
const ANGLE_VALIDATED = {
  1: 0x00ae,  // confirmé 
  10: 0x06d1  // confirmé 
}
function angleBytes (deg) {
  const raw = ANGLE_VALIDATED[deg] != null
    ? ANGLE_VALIDATED[deg]
    : Math.floor((deg * Math.PI) / 180 / 0.0001)
  return [raw & 0xff, (raw >> 8) & 0xff]
}

const h2 = (n) => n.toString(16).toUpperCase().padStart(2, '0')

// Compteur de séquence fast-packet (3 bits de poids fort du 1er octet), roule 0..7.
let seqGroup = 0
function nextSeq () {
  seqGroup = (seqGroup + 1) % 8
  return [h2(seqGroup << 5), h2((seqGroup << 5) | 1)]
}

// Construit les 2 trames CAN (chaînes "ID#DATA" pour cansend) pour un payload 130850.
// saHex   = adresse source (contrôleur actif), ex "07".
// cmdClass = octet P5 : 0x0A pour les commandes AP (mode/cap/tack), 0x02 pour le NFU (barre directe).
// target   = adresse N2K cible = celle du calculateur AC42 (détectée dynamiquement ; 0x02 par défaut,
//            valeur observée sur le bateau de dev — variable d'un bateau à l'autre).
function buildApCommand (saHex, payload6to11, cmdClass = 0x0a, target = 0x02) {
  const [s0, s1] = nextSeq()
  const id = `09FF22${saHex.toUpperCase().padStart(2, '0')}`
  const frame0 = `${id}#${s0}0C419F${h2(target)}FFFF${h2(cmdClass)}`
  const rest = payload6to11.map(h2).join('') // 6 octets (P6..P11)
  const frame1 = `${id}#${s1}${rest}FF`       // + 1 octet de padding
  return [frame0, frame1]
}

// --- Commandes publiques ---

// Changement de cap relatif. deg > 0, direction 'bear' (+/abattre) ou 'luff' (-/lofer).
// ⚠️ Le sens de l'octet dir DÉPEND DU MODE :
//   - mode Cap (Auto)  : bear(+)=tribord=0x03, luff(-)=bâbord=0x02  (validé au test)
//   - mode Vent (Wind) : INVERSÉ — bear(+, s'éloigner du vent)=0x02, luff(-, se rapprocher)=0x03
// (En Vent le pilote raisonne en magnitude d'angle au vent, pas en tribord/bâbord.)
function changeCourse (saHex, deg, direction, mode, target) {
  const [aLo, aHi] = angleBytes(Math.abs(deg))
  const dir = mode === 'Wind'
    ? (direction === 'bear' ? 0x02 : 0x03)
    : (direction === 'bear' ? 0x03 : 0x02)
  const p = [EVENT.changeCourse, 0x00, dir, aLo, aHi, 0xff]
  return buildApCommand(saHex, p, 0x0a, target)
}

// Aides sémantiques : +N = abattre, -N = lofer.
const plus = (saHex, deg, mode, target) => changeCourse(saHex, deg, 'bear', mode, target)
const minus = (saHex, deg, mode, target) => changeCourse(saHex, deg, 'luff', mode, target)

// Changement de mode (payloads P6..P11 capturés depuis un pupitre B&G).
const MODE_PAYLOAD = {
  auto: [EVENT.auto, 0x00, 0xff, 0xff, 0xff, 0xff],
  wind: [EVENT.wind, 0x00, 0x00, 0x00, 0x00, 0x00],
  standby: [EVENT.standby, 0x00, 0x00, 0x00, 0x00, 0x00]
}
function mode (saHex, name, target) {
  const p = MODE_PAYLOAD[name]
  if (!p) throw new Error(`mode inconnu: ${name}`)
  return buildApCommand(saHex, p, 0x0a, target)
}

// Virement. direction 'stbd' (tribord) ou 'port' (bâbord).
// Confirmé : pour le TACK, dir 0x02 = barre à bâbord, 0x03 = barre à tribord
// (inverse du ChangeCourse, où 0x02 = abattre/tribord).
function tack (saHex, direction, target) {
  const dir = direction === 'stbd' ? 0x03 : 0x02
  return buildApCommand(saHex, [EVENT.tack, 0x00, dir, 0xff, 0xff, 0xff], 0x0a, target)
}

// Non-Follow-Up : barre directe (fonctionne en standby). direction 'stbd' | 'port' | 'stop'.
// Modèle : envoyer 'stbd'/'port' fait bouger la barre, 'stop' l'arrête. À rafraîchir tant que maintenu.
// Capturé : event 0x0D, dir 0x05=tribord / 0x04=bâbord / 0xFF=stop, cmdClass 0x02.
function rudder (saHex, direction, target) {
  const dir = direction === 'stbd' ? 0x05 : direction === 'port' ? 0x04 : 0xff
  return buildApCommand(saHex, [0x0d, 0x00, dir, 0x00, 0x00, 0x00], 0x02, target)
}

module.exports = { EVENT, DIR, angleBytes, buildApCommand, changeCourse, plus, minus, mode, tack, rudder, _resetSeq: () => { seqGroup = 0 } }
