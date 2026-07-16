'use strict'
// Émission de trames CAN brutes via `cansend` (can-utils).
//
// Pourquoi pas le `nmea2000out` de SignalK ? Parce que canboatjs est bindé sur l'adresse XXX
// et estampille toujours la source à XXX. Or l'AC42 n'obéit qu'aux commandes portant la
// source address d'un contrôleur reconnu (voir lib/controller.js). On doit donc écrire la
// trame brute nous-mêmes avec le bon ID CAN. `cansend` est déjà installé et prouvé à bord.
// (v2 possible : binding socketcan natif pour éviter le fork de process.)

const { execFile } = require('child_process')

// Envoie une trame "ID#DATA". Renvoie une Promise.
function sendFrame (iface, frame) {
  return new Promise((resolve, reject) => {
    execFile('cansend', [iface, frame], (err, stdout, stderr) => {
      if (err) return reject(new Error(`cansend ${frame}: ${stderr || err.message}`))
      resolve()
    })
  })
}

// Envoie une séquence de trames (fast-packet) dans l'ordre.
async function sendFrames (iface, frames) {
  for (const f of frames) await sendFrame(iface, f)
}

module.exports = { sendFrame, sendFrames }
