import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { traceIdMiddleware } from "./lib/trace"
import { completionRoutes } from "./routes/chat-completions/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(traceIdMiddleware)
server.use(logger())
server.use(cors())

server.get("/", (c) => c.text("GPT Proxy running"))
server.get("/usage-viewer", (c) => {
  // Try multiple resolution paths for pages/usage.html
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(thisDir, "../pages/usage.html"),
    resolve(thisDir, "../../pages/usage.html"),
    resolve(process.cwd(), "pages/usage.html"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return c.html(readFileSync(candidate, "utf8"))
    }
  }
  return c.text("Usage viewer HTML not found. Ensure pages/usage.html exists.", 404)
})
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/usage", usageRoute)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/usage", usageRoute)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
