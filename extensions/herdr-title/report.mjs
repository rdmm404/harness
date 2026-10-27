// Presentation only: Herdr's installed Pi integration owns agent state.
import net from "node:net"

export function reportTitle(agent, title, isCurrent = () => true) {
  const { HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID } = process.env
  if (HERDR_ENV !== "1" || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return Promise.resolve(true)
  const text = String(title ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200)
  return new Promise((resolve) => {
    let finished = false
    const socket = net.createConnection(HERDR_SOCKET_PATH)
    const finish = (ok) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 500)
    socket.on("connect", () => {
      if (!isCurrent()) return finish(false)
      socket.write(JSON.stringify({
        id: `title:${agent}:${Date.now()}`,
        method: "pane.report_metadata",
        params: {
          pane_id: HERDR_PANE_ID,
          source: "user:herdr-title:pi",
          agent: "pi",
          applies_to_source: "herdr:pi",
          ...(text ? { title: text } : { clear_title: true }),
          tokens: { title: text || "Pi", kind: "Pi" },
          ttl_ms: 60000,
        },
      }) + "\n")
    })
    let data = ""
    socket.on("data", (chunk) => {
      data += chunk
      if (!data.includes("\n")) return
      try { finish(!JSON.parse(data.split("\n")[0]).error) } catch { finish(false) }
    })
    socket.on("error", () => finish(false))
    socket.on("end", () => finish(false))
  })
}
