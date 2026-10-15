// Dev helper: drive the running Electron app over the Chrome DevTools Protocol.
// Start the app with:  npx electron . --remote-debugging-port=9223
// Usage: node scripts/cdp.mjs shot <out.png> | eval "<js expression>"
import { writeFileSync } from 'node:fs'

const port = process.env.CDP_PORT ?? 9223
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== myId) return
      ws.removeEventListener('message', onMsg)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'shot') {
  await call('Page.bringToFront')
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(arg, Buffer.from(data, 'base64'))
  console.log('saved', arg)
} else if (cmd === 'eval') {
  await call('Page.bringToFront') // background windows get no requestAnimationFrame
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result.value ?? r.result, null, 1))
}
ws.close()
if (cmd === 'logs') {
  // collect console + exceptions for N ms while running an optional expression
  const lines = []
  const ws2 = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => ws2.addEventListener('open', r, { once: true }))
  ws2.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled') lines.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '))
    if (m.method === 'Runtime.exceptionThrown') lines.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
  })
  ws2.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
  ws2.send(JSON.stringify({ id: 3, method: 'Page.bringToFront' }))
  if (arg) ws2.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: arg } }))
  await new Promise((r) => setTimeout(r, Number(process.argv[4] ?? 5000)))
  console.log(lines.join('\n').slice(0, 6000))
  ws2.close()
}
