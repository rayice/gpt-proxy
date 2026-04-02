import { Hono } from "hono"

import { getUsageReport } from "~/lib/usage-tracker"

export const usageRoute = new Hono()

usageRoute.get("/", (c) => {
  return c.json(getUsageReport())
})
