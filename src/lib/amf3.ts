/**
 * AMF3, the encoding of the client's data files (`*.amf3.deflate`: raw deflate of one AMF3 value), as far as the
 * battle scripts use it (FT-74): undefined, null, booleans, integers, doubles, strings, dense arrays and objects with
 * sealed or dynamic traits. A value decoded and encoded again gives the same bytes: strings, objects and traits are
 * referenced the way the client's writer references them (a string, object or trait seen before is written as a
 * reference), and a double stays a double even when it holds a whole number (`Amf3Double`).
 */

export class Amf3Double {
    constructor(public value: number) {}
}

export interface Amf3Traits {
    className: string
    dynamic: boolean
    sealed: string[]
}

export class Amf3Object {
    constructor(public traits: Amf3Traits, public values: Map<string, Amf3Value>) {}
}

export type Amf3Value = undefined | null | boolean | number | Amf3Double | string | Amf3Value[] | Amf3Object

const INT_MIN = -(1 << 28), INT_MAX = (1 << 28) - 1

class Reader {
    private pos = 0
    private readonly strings: string[] = []
    private readonly objects: (Amf3Value[] | Amf3Object)[] = []
    private readonly traits: Amf3Traits[] = []
    constructor(private readonly buf: Buffer) {}

    get done(): boolean { return this.pos >= this.buf.length }

    private byte(): number {
        if (this.pos >= this.buf.length) throw new Error("AMF3: unexpected end of data")
        return this.buf[this.pos++]
    }

    private u29(): number {
        let value = 0
        for (let i = 0; i < 3; i++) {
            const b = this.byte()
            value = (value << 7) | (b & 0x7f)
            if (!(b & 0x80)) return value
        }
        return (value << 8) | this.byte()
    }

    private string(): string {
        const header = this.u29()
        if (!(header & 1)) {
            const ref = this.strings[header >> 1]
            if (ref === undefined) throw new Error("AMF3: bad string reference")
            return ref
        }
        const length = header >> 1
        if (this.pos + length > this.buf.length) throw new Error("AMF3: string past the end")
        const text = this.buf.toString("utf8", this.pos, this.pos + length)
        this.pos += length
        if (text !== "") this.strings.push(text)
        return text
    }

    value(): Amf3Value {
        const marker = this.byte()
        switch (marker) {
            case 0x00: return undefined
            case 0x01: return null
            case 0x02: return false
            case 0x03: return true
            case 0x04: {
                const v = this.u29()
                return v & 0x10000000 ? v - 0x20000000 : v
            }
            case 0x05: {
                if (this.pos + 8 > this.buf.length) throw new Error("AMF3: double past the end")
                const v = this.buf.readDoubleBE(this.pos)
                this.pos += 8
                return new Amf3Double(v)
            }
            case 0x06: return this.string()
            case 0x09: {
                const header = this.u29()
                if (!(header & 1)) return this.reference(header >> 1)
                if (this.string() !== "") throw new Error("AMF3: associative arrays are not supported")
                const array: Amf3Value[] = []
                this.objects.push(array)
                for (let i = 0; i < header >> 1; i++) array.push(this.value())
                return array
            }
            case 0x0a: {
                const header = this.u29()
                if (!(header & 1)) return this.reference(header >> 1)
                let traits: Amf3Traits
                if (!(header & 2)) {
                    traits = this.traits[header >> 2]
                    if (!traits) throw new Error("AMF3: bad traits reference")
                } else {
                    if (header & 4) throw new Error("AMF3: externalizable objects are not supported")
                    const className = this.string()
                    const sealed: string[] = []
                    for (let i = 0; i < header >> 4; i++) sealed.push(this.string())
                    traits = { className, dynamic: !!(header & 8), sealed }
                    this.traits.push(traits)
                }
                const object = new Amf3Object(traits, new Map())
                this.objects.push(object)
                for (const name of traits.sealed) object.values.set(name, this.value())
                if (traits.dynamic) for (let name = this.string(); name !== ""; name = this.string()) object.values.set(name, this.value())
                return object
            }
            default: throw new Error(`AMF3: unsupported marker ${marker}`)
        }
    }

    private reference(index: number): Amf3Value[] | Amf3Object {
        const ref = this.objects[index]
        if (!ref) throw new Error("AMF3: bad object reference")
        return ref
    }
}

class Writer {
    private readonly chunks: Buffer[] = []
    private readonly strings = new Map<string, number>()
    private readonly objects = new Map<object, number>()
    private readonly traits: Amf3Traits[] = []

    private bytes(...b: number[]) { this.chunks.push(Buffer.from(b)) }

    private u29(value: number) {
        if (value < 0 || value > 0x1fffffff) throw new Error("AMF3: u29 out of range")
        if (value < 0x80) this.bytes(value)
        else if (value < 0x4000) this.bytes((value >> 7) | 0x80, value & 0x7f)
        else if (value < 0x200000) this.bytes((value >> 14) | 0x80, ((value >> 7) & 0x7f) | 0x80, value & 0x7f)
        else this.bytes((value >> 22) | 0x80, ((value >> 15) & 0x7f) | 0x80, ((value >> 8) & 0x7f) | 0x80, value & 0xff)
    }

    private string(text: string) {
        if (text === "") return this.u29(1)
        const ref = this.strings.get(text)
        if (ref !== undefined) return this.u29(ref << 1)
        this.strings.set(text, this.strings.size)
        const data = Buffer.from(text, "utf8")
        this.u29((data.length << 1) | 1)
        this.chunks.push(data)
    }

    private sameTraits(a: Amf3Traits, b: Amf3Traits): boolean {
        return a === b || (a.className === b.className && a.dynamic === b.dynamic
            && a.sealed.length === b.sealed.length && a.sealed.every((name, i) => name === b.sealed[i]))
    }

    value(v: Amf3Value) {
        if (v === undefined) return this.bytes(0x00)
        if (v === null) return this.bytes(0x01)
        if (v === false) return this.bytes(0x02)
        if (v === true) return this.bytes(0x03)
        if (typeof v === "number" || v instanceof Amf3Double) {
            const n = typeof v === "number" ? v : v.value
            if (typeof v === "number" && Number.isInteger(n) && n >= INT_MIN && n <= INT_MAX) {
                this.bytes(0x04)
                return this.u29(n < 0 ? n + 0x20000000 : n)
            }
            const data = Buffer.alloc(8)
            data.writeDoubleBE(n)
            this.bytes(0x05)
            return this.chunks.push(data)
        }
        if (typeof v === "string") {
            this.bytes(0x06)
            return this.string(v)
        }
        const ref = this.objects.get(v)
        if (Array.isArray(v)) {
            this.bytes(0x09)
            if (ref !== undefined) return this.u29(ref << 1)
            this.objects.set(v, this.objects.size)
            this.u29((v.length << 1) | 1)
            this.string("")
            for (const item of v) this.value(item)
            return
        }
        this.bytes(0x0a)
        if (ref !== undefined) return this.u29(ref << 1)
        this.objects.set(v, this.objects.size)
        const index = this.traits.findIndex(t => this.sameTraits(t, v.traits))
        if (index >= 0) this.u29((index << 2) | 1)
        else {
            this.traits.push(v.traits)
            this.u29((v.traits.sealed.length << 4) | (v.traits.dynamic ? 8 : 0) | 3)
            this.string(v.traits.className)
            for (const name of v.traits.sealed) this.string(name)
        }
        for (const name of v.traits.sealed) this.value(v.values.get(name))
        if (v.traits.dynamic) {
            for (const [name, item] of v.values) {
                if (v.traits.sealed.includes(name)) continue
                this.string(name)
                this.value(item)
            }
            this.string("")
        }
    }

    result(): Buffer { return Buffer.concat(this.chunks) }
}

/** One AMF3 value; the data must hold nothing after it. */
export function decodeAmf3(data: Buffer): Amf3Value {
    const reader = new Reader(data)
    const value = reader.value()
    if (!reader.done) throw new Error("AMF3: data after the value")
    return value
}

export function encodeAmf3(value: Amf3Value): Buffer {
    const writer = new Writer()
    writer.value(value)
    return writer.result()
}
