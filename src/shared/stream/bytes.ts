// Growable byte writer / reader with LEB128 varints and zigzag signed ints. Used by the stream encoder (main)
// and decoder (renderer worker), so it must stay free of Node APIs.

export class ByteWriter {
  private buf = new Uint8Array(1 << 16)
  private pos = 0

  get length(): number {
    return this.pos
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  u8(v: number): void {
    this.ensure(1)
    this.buf[this.pos++] = v & 0xff
  }

  i8(v: number): void {
    this.u8(Math.max(-128, Math.min(127, Math.round(v))) & 0xff)
  }

  u16(v: number): void {
    this.ensure(2)
    v = Math.max(0, Math.min(0xffff, Math.round(v)))
    this.buf[this.pos++] = v & 0xff
    this.buf[this.pos++] = v >>> 8
  }

  /** unsigned LEB128, up to 2^53 */
  varint(v: number): void {
    if (v < 0) throw new RangeError(`varint must be >= 0, got ${v}`)
    this.ensure(8)
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80
      v = Math.floor(v / 0x80)
    }
    this.buf[this.pos++] = v
  }

  /** signed via zigzag */
  svarint(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1)
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

export class ByteReader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError('read past end')
    return this.buf[this.pos++]
  }

  i8(): number {
    const v = this.u8()
    return v > 127 ? v - 256 : v
  }

  u16(): number {
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8)
    this.pos += 2
    return v
  }

  varint(): number {
    let result = 0
    let mul = 1
    for (;;) {
      const b = this.u8()
      result += (b & 0x7f) * mul
      if (b < 0x80) return result
      mul *= 0x80
    }
  }

  svarint(): number {
    const v = this.varint()
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }
}
