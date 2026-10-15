// Dev helper: drive the running Electron app over the Chrome DevTools Protocol.
// Start the app with:  npx electron . --remote-debugging-port=9223
//   (plus --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding
//    --disable-background-timer-throttling, or a covered window gets no requestAnimationFrame)
// Usage:
//   node scripts/cdp.mjs shot <out.png>                 screenshot
//   node scripts/cdp.mjs eval "<js expression>"         evaluate (awaits promises), print the result
//   node scripts/cdp.mjs logs "<js expression>" [ms]    run it and print console output / exceptions for ms
//   node scripts/cdp.mjs drop <file> [file...]          simulate dragging files from the OS onto the window
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
await call('Page.bringToFront')
if (cmd === 'shot') {
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(arg, Buffer.from(data, 'base64'))
  console.log('saved', arg)
} else if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(r.result.value ?? r.result, null, 1))
} else if (cmd === 'logs') {
  const lines = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled')
      lines.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '))
    if (m.method === 'Runtime.exceptionThrown')
      lines.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
  })
  await call('Runtime.enable')
  if (arg) void call('Runtime.evaluate', { expression: arg }).catch(() => {})
  await new Promise((r) => setTimeout(r, Number(process.argv[4] ?? 5000)))
  console.log(lines.join('\n').slice(0, 6000))
} else if (cmd === 'drop') {
  const data = { items: [], files: process.argv.slice(3), dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) await call('Input.dispatchDragEvent', { type, x: 600, y: 400, data })
  console.log('dropped', data.files)
}
ws.close()
