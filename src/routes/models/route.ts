import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const models = state.models.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: model.vendor,
      display_name: model.name,
    }))

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
