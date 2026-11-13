/** Just enough XML for the S3 API: building responses and reading the few request bodies it takes. */

const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/'

/** Escape text for an XML element body. */
export function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** `<name>escaped value</name>`; an undefined/null value omits the element. */
export function xmlElement(name: string, value: string | number | boolean | null | undefined): string {
  if (value === undefined || value === null) return ''
  return `<${name}>${xmlEscape(String(value))}</${name}>`
}

/** `<name>` wrapping already-built child XML. */
export function xmlNode(name: string, children: string): string {
  return `<${name}>${children}</${name}>`
}

/** A full XML document with the S3 namespace on the root element. */
export function xmlDocument(root: string, children: string, namespace = true): string {
  const ns = namespace ? ` xmlns="${S3_NS}"` : ''
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root}${ns}>${children}</${root}>`
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** The raw inner XML of every `<tag>` element (namespace prefixes ignored). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g')
  const out: string[] = []
  for (const m of xml.matchAll(re)) out.push(m[1])
  return out
}

/** The decoded text of the first `<tag>` element, or undefined. */
export function xmlText(xml: string, tag: string): string | undefined {
  const block = xmlBlocks(xml, tag)[0]
  return block === undefined ? undefined : decodeEntities(block)
}
