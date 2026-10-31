// The translation overlay is on by default (I18N-13): I18N unset, empty or unknown means on, only `off` turns it off.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";

const saved = process.env.I18N

after(() => {
    if (saved === undefined) delete process.env.I18N
    else process.env.I18N = saved
})

test("I18N defaults to on, and only off turns it off", async () => {
    const { cleanup } = await createTestServer()
    try {
        const { i18nMode } = await import("../src/lib/assetLayers")
        const cases: [string | undefined, "on" | "off"][] = [
            [undefined, "on"], ["", "on"], ["on", "on"], [" ON ", "on"], ["yes", "on"], ["off", "off"], ["Off", "off"],
        ]
        for (const [value, expected] of cases) {
            if (value === undefined) delete process.env.I18N
            else process.env.I18N = value
            assert.equal(i18nMode(), expected, `I18N=${value}`)
        }
    } finally {
        await cleanup()
    }
})
