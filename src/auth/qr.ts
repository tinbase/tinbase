/**
 * Minimal QR Code generator (byte mode, full version/ECC/mask support) used to
 * render the MFA enrollment otpauth:// URI as a scannable SVG. Compact port of
 * Nayuki's public-domain "QR Code generator" algorithm — no dependencies.
 * Source of the algorithm: https://www.nayuki.io/page/qr-code-generator-library
 */

// Error-correction level → format bits. We use M (medium) like GoTrue.
const ECC_M = { ordinal: 0, formatBits: 0 }

const ECC_CODEWORDS_PER_BLOCK = [
  // index by version (1..40); level M row
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
]
const NUM_ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function getNumDataCodewords(ver: number): number {
  return (
    Math.floor(getNumRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ver] * NUM_ERROR_CORRECTION_BLOCKS[ver]
  )
}

// ── Reed-Solomon over GF(256) ──────────────────────────────────────────────
function reedSolomonComputeDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = reedSolomonMultiply(root, 0x02)
  }
  return result
}
function reedSolomonComputeRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length)
  for (const b of data) {
    const factor = b ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < result.length; i++) result[i] ^= reedSolomonMultiply(divisor[i], factor)
  }
  return result
}
function reedSolomonMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

class QrCode {
  readonly size: number
  private modules: boolean[][]
  private isFunction: boolean[][]

  static encodeText(text: string): QrCode {
    const bytes = new TextEncoder().encode(text)
    // byte-mode segment bit length = 4 (mode) + charCountBits + 8*len
    let version = 1
    for (; version <= 40; version++) {
      const dataCapacityBits = getNumDataCodewords(version) * 8
      const ccBits = version < 10 ? 8 : 16
      const usedBits = 4 + ccBits + bytes.length * 8
      if (usedBits <= dataCapacityBits) break
    }
    if (version > 40) throw new Error('QR data too long')

    const bb: number[] = []
    const append = (val: number, len: number) => {
      for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1)
    }
    append(0x4, 4) // byte mode
    append(bytes.length, version < 10 ? 8 : 16)
    for (const b of bytes) append(b, 8)

    const dataCapacityBits = getNumDataCodewords(version) * 8
    append(0, Math.min(4, dataCapacityBits - bb.length))
    while (bb.length % 8 !== 0) bb.push(0)
    for (let pad = 0xec; bb.length < dataCapacityBits; pad ^= 0xec ^ 0x11) append(pad, 8)

    const dataCodewords = new Uint8Array(bb.length / 8)
    for (let i = 0; i < bb.length; i++) dataCodewords[i >>> 3] |= bb[i] << (7 - (i & 7))

    return new QrCode(version, dataCodewords)
  }

  private constructor(readonly version: number, dataCodewords: Uint8Array) {
    this.size = version * 4 + 17
    const row = () => new Array(this.size).fill(false)
    this.modules = Array.from({ length: this.size }, row)
    this.isFunction = Array.from({ length: this.size }, row)

    this.drawFunctionPatterns()
    const allCodewords = this.addEccAndInterleave(dataCodewords)
    this.drawCodewords(allCodewords)

    // pick the mask with the lowest penalty (all masks are valid; this is polish)
    let minPenalty = Infinity
    let bestMask = 0
    for (let mask = 0; mask < 8; mask++) {
      this.applyMask(mask)
      this.drawFormatBits(mask)
      const penalty = this.getPenaltyScore()
      if (penalty < minPenalty) {
        bestMask = mask
        minPenalty = penalty
      }
      this.applyMask(mask) // undo
    }
    this.applyMask(bestMask)
    this.drawFormatBits(bestMask)
  }

  getModule(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x]
  }
  private setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark
    this.isFunction[y][x] = true
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0)
      this.setFunctionModule(i, 6, i % 2 === 0)
    }
    this.drawFinderPattern(3, 3)
    this.drawFinderPattern(this.size - 4, 3)
    this.drawFinderPattern(3, this.size - 4)

    const alignPos = this.getAlignmentPatternPositions()
    const n = alignPos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)))
          this.drawAlignmentPattern(alignPos[i], alignPos[j])
      }
    }
    this.drawFormatBits(0)
    this.drawVersion()
  }

  private drawFormatBits(mask: number): void {
    const data = (ECC_M.formatBits << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, ((bits >>> i) & 1) !== 0)
    this.setFunctionModule(8, 7, ((bits >>> 6) & 1) !== 0)
    this.setFunctionModule(8, 8, ((bits >>> 7) & 1) !== 0)
    this.setFunctionModule(7, 8, ((bits >>> 8) & 1) !== 0)
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, ((bits >>> i) & 1) !== 0)
    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, ((bits >>> i) & 1) !== 0)
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, ((bits >>> i) & 1) !== 0)
    this.setFunctionModule(8, this.size - 8, true)
  }

  private drawVersion(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, bit)
      this.setFunctionModule(b, a, bit)
    }
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }

  private getAlignmentPatternPositions(): number[] {
    if (this.version === 1) return []
    const numAlign = Math.floor(this.version / 7) + 2
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
    const result = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  private addEccAndInterleave(data: Uint8Array): Uint8Array {
    const ver = this.version
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver]
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver]
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8)
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
    const shortBlockLen = Math.floor(rawCodewords / numBlocks)

    const blocks: Uint8Array[] = []
    const rsDiv = reedSolomonComputeDivisor(blockEccLen)
    let k = 0
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)
      const dat = data.slice(k, k + datLen)
      k += datLen
      const ecc = reedSolomonComputeRemainder(dat, rsDiv)
      const block = new Uint8Array(shortBlockLen + 1)
      block.set(dat, 0)
      block.set(ecc, block.length - blockEccLen)
      blocks.push(block)
    }

    const result = new Uint8Array(rawCodewords)
    let ri = 0
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        // skip the unused cell in short blocks' data region
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
          result[ri++] = blocks[j][i]
        }
      }
    }
    return result
  }

  private drawCodewords(data: Uint8Array): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
            i++
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert = false
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
        }
        if (invert && !this.isFunction[y][x]) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  private getPenaltyScore(): number {
    let result = 0
    const size = this.size
    // adjacent same-color runs in rows/columns
    for (let y = 0; y < size; y++) {
      let runColor = false
      let runLen = 0
      for (let x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += 3
          else if (runLen > 5) result++
        } else {
          runColor = this.modules[y][x]
          runLen = 1
        }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColor = false
      let runLen = 0
      for (let y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += 3
          else if (runLen > 5) result++
        } else {
          runColor = this.modules[y][x]
          runLen = 1
        }
      }
    }
    // 2x2 blocks
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y][x]
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1])
          result += 3
      }
    }
    // proportion of dark modules
    let dark = 0
    for (const rowArr of this.modules) for (const v of rowArr) if (v) dark++
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += k * 10
    return result
  }

  /** Render as an SVG string with a quiet-zone border (module units). */
  toSvgString(border: number): string {
    const dim = this.size + border * 2
    const parts: string[] = []
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`)
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
      `<path d="${parts.join('')}" fill="#000000"/>` +
      `</svg>`
    )
  }
}

/** Encode `text` as a QR SVG data URI (works directly as an <img src>). */
export function qrSvgDataUri(text: string): string {
  const svg = QrCode.encodeText(text).toSvgString(4)
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
