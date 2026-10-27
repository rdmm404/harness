import assert from "node:assert/strict"
import { test } from "node:test"
import net from "node:net"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { reportTitle } from "../report.mjs"
import piPlugin from "../index.ts"

test("metadata changes presentation, never lifecycle", async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  const dir = await mkdtemp("/tmp/opencode/herdr-title-test-")
  const socket = `${dir}/test.sock`
  let request
  const server = net.createServer((client) => client.once("data", (data) => {
    request = JSON.parse(String(data))
    client.end('{"result":{}}\n')
  }))
  await new Promise((resolve) => server.listen(socket, resolve))
  const saved = { ...process.env }
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p2" })
  try {
    assert.equal(await reportTitle("pi", "Fix\nparser"), true)
    assert.equal(request.method, "pane.report_metadata")
    assert.deepEqual(request.params.tokens, { title: "Fix parser", kind: "π" })
    assert.equal(request.params.applies_to_source, "herdr:pi")
    assert.equal(request.params.state, undefined)
    assert.equal(await reportTitle("pi", ""), true)
    assert.equal(request.params.clear_title, true)
    assert.equal(await reportTitle("pi", "stale", () => false), false)
  } finally {
    process.env = saved
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true })
  }
})

function harness(complete, name = "") {
  const handlers = new Map(), names = [], warnings = []
  const saved = { ...process.env }
  process.env.HERDR_ENV = "0"
  const pi = {
    on: (event, fn) => handlers.set(event, fn),
    getSessionName: () => name,
    setSessionName: (value) => { name = value; names.push(value) },
  }
  const ctx = {
    mode: "tui", sessionManager: { getSessionId: () => "session-1" },
    ui: { notify: (message) => warnings.push(message) },
    modelRegistry: {
      find: (provider, model) => {
        assert.equal(provider, "openai-codex")
        assert.equal(model, "gpt-6-luna")
        return { id: model }
      },
      complete,
    },
  }
  piPlugin(pi)
  handlers.get("session_start")({}, ctx)
  return {
    names, warnings, pi,
    prompt: () => handlers.get("before_agent_start")({ prompt: "Fix the parser" }, ctx),
    close: () => { handlers.get("session_shutdown")(); process.env = saved },
  }
}
const response = { stopReason: "stop", content: [{ type: "text", text: "Fix parser handling" }] }
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test("configured model and lowest reasoning, once per unnamed session", async () => {
  let calls = 0
  const h = harness(async (_model, context, options) => {
    calls++
    assert.equal(options.reasoningEffort, "none")
    assert.equal(context.messages[0].content[0].text, "Fix the parser")
    return response
  })
  try {
    await h.prompt(); await settle(); await h.prompt()
    assert.deepEqual(h.names, ["Fix parser handling"])
    assert.equal(calls, 1)
    assert.deepEqual(h.warnings, [])
  } finally { h.close() }
})

test("manual rename during generation wins", async () => {
  let finish
  const h = harness(() => new Promise((resolve) => { finish = resolve }))
  try {
    await h.prompt(); await settle()
    h.pi.setSessionName("My manual title")
    finish(response); await settle()
    assert.deepEqual(h.names, ["My manual title"])
  } finally { h.close() }
})

test("leaving the session discards stale generation", async () => {
  let finish
  const h = harness(() => new Promise((resolve) => { finish = resolve }))
  await h.prompt(); await settle(); h.close()
  finish(response); await settle()
  assert.deepEqual(h.names, [])
})

test("existing title skips generation; failures warn once without fallback", async () => {
  let calls = 0
  const complete = async () => { calls++; throw new Error("No authentication") }
  let h = harness(complete, "Existing title")
  try {
    await h.prompt(); await settle()
    assert.equal(calls, 0)
  } finally { h.close() }
  h = harness(complete)
  try {
    await h.prompt(); await settle(); await h.prompt()
    assert.equal(calls, 1)
    assert.deepEqual(h.names, [])
    assert.match(h.warnings[0], /No authentication/)
  } finally { h.close() }
})
