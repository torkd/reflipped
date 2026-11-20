import { monitorEventLoopDelay } from "perf_hooks";
import type { FastifyInstance } from "fastify";

/** Process-local, bounded aggregates; route labels come only from Fastify's registered templates. */
export class Metrics {
    private readonly delay = monitorEventLoopDelay({ resolution: 20 })
    private listeners = 0
    private readonly routes = new Map<string, { listener: string, method: string, route: string, status: string, count: number, totalMs: number, maxMs: number }>()

    register(server: FastifyInstance, listener: "game" | "admin") {
        if (this.listeners++ === 0) this.delay.enable()
        server.addHook("onResponse", (request, reply, done) => {
            // Unknown paths all share one label, including 404s; never use request.url or parameter values.
            const route = request.routeOptions.url || "<unmatched>"
            const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)
                ? request.method : "OTHER"
            const status = `${Math.min(5, Math.max(1, Math.floor(reply.statusCode / 100)))}xx`
            const key = JSON.stringify([listener, method, route, status])
            let row = this.routes.get(key)
            if (!row) {
                row = { listener, method, route, status, count: 0, totalMs: 0, maxMs: 0 }
                this.routes.set(key, row)
            }
            row.count++
            row.totalMs += reply.elapsedTime
            row.maxMs = Math.max(row.maxMs, reply.elapsedTime)
            done()
        })
        server.addHook("onClose", (_instance, done) => {
            if (--this.listeners === 0) this.delay.disable()
            done()
        })
    }

    snapshot() {
        const samples = this.delay.count
        return {
            uptimeSeconds: process.uptime(),
            eventLoopDelayMs: {
                samples,
                mean: samples ? this.delay.mean / 1e6 : 0,
                max: samples ? this.delay.max / 1e6 : 0,
                p99: samples ? this.delay.percentile(99) / 1e6 : 0
            },
            routes: [...this.routes.values()].map(row => ({ ...row }))
        }
    }
}
