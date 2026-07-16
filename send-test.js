// Test d'intégration : envoie une commande depuis le contrôleur actif détecté.
// Usage: node send-test.js mode:auto | mode:wind | mode:standby | course:bear:10 | course:luff:10 | tack:stbd | tack:port
const CD = require('./lib/controller')
const cmds = require('./lib/commands')
const { sendFrames } = require('./lib/cansend')

const arg = process.argv[2] || ''
const d = new CD({})
d.start()
setTimeout(async () => {
  const src = d.active()
  if (!src) { console.log('NO ACTIVE CONTROLLER'); process.exit(1) }
  const ap = d.apAddress()
  const [a, b, c] = arg.split(':')
  let frames
  if (a === 'mode') frames = cmds.mode(src, b, ap)
  else if (a === 'course') frames = cmds.changeCourse(src, +c, b, d.currentMode(), ap)
  else if (a === 'tack') frames = cmds.tack(src, b, ap)
  else if (a === 'rudder') frames = cmds.rudder(src, b, ap)
  else { console.log('cmd inconnue:', arg); process.exit(1) }
  console.log('src=' + src, 'ap=' + ap, 'frames:', frames.map(f => f.split('#')[1]).join(' '))
  await sendFrames('can0', frames)
  console.log('SENT')
  d.stop()
  process.exit(0)
}, 2500)
