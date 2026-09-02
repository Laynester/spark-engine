import { LList, LPropList } from './values.js';
import type { LVal } from './values.js';

function makeNode(
  name: string,
  children: LVal[],
  attrNames: string[],
  attrValues: string[],
): LPropList {
  const p = new Map<string, LVal>();
  p.set('name', name);
  p.set('child', new LList(children));
  p.set('attributeName', new LList(attrNames));
  p.set('attributeValue', new LList(attrValues));
  return new LPropList(p);
}

function makeTextNode(text: string): LPropList {
  const p = new Map<string, LVal>();
  p.set('name', '#text');
  p.set('text', text);
  p.set('child', new LList([]));
  p.set('attributeName', new LList([]));
  p.set('attributeValue', new LList([]));
  return new LPropList(p);
}

function decodeEntities(value: string): string {
  return value
    .split('&quot;').join('"')
    .split('&apos;').join("'")
    .split('&lt;').join('<')
    .split('&gt;').join('>')
    .split('&amp;').join('&');
}

function hasNonWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 32) return true;
  }
  return false;
}

class XmlParser {
  private pos = 0;

  constructor(private xml: string) {}

  parseDocument(): LPropList {
    const children: LVal[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.xml.length) return makeNode('#document', children, [], []);
      if (this.startsWith('<?')) {
        this.skipUntil('?>');
        continue;
      }
      if (this.startsWith('<!--')) {
        this.skipUntil('-->');
        continue;
      }
      if (this.startsWith('<!')) {
        this.skipUntil('>');
        continue;
      }
      if (this.peek() === '<') {
        children.push(this.parseElement());
        continue;
      }
      this.readText();
    }
  }

  private parseElement(): LVal {
    this.expect('<');
    const name = this.readName();
    const attrNames: string[] = [];
    const attrValues: string[] = [];
    for (;;) {
      this.skipWs();
      if (this.startsWith('/>')) {
        this.pos += 2;
        return makeNode(name, [], attrNames, attrValues);
      }
      if (this.startsWith('>')) {
        this.pos += 1;
        break;
      }
      attrNames.push(this.readName());
      this.skipWs();
      this.expect('=');
      this.skipWs();
      attrValues.push(decodeEntities(this.readQuotedValue()));
    }
    const children: LVal[] = [];
    let textContent = '';
    for (;;) {
      if (this.pos >= this.xml.length) throw new Error(`Unclosed tag: ${name}`);
      if (this.startsWith('</')) {
        this.pos += 2;
        const closeName = this.readName();
        this.skipWs();
        this.expect('>');
        if (name !== closeName) throw new Error(`Mismatched closing tag: ${closeName}`);
        if (children.length === 0 && textContent !== '') children.push(makeTextNode(textContent));
        return makeNode(name, children, attrNames, attrValues);
      }
      if (this.startsWith('<!--')) {
        this.skipUntil('-->');
        continue;
      }
      if (this.startsWith('<![CDATA[')) {
        this.skipUntil(']]>');
        continue;
      }
      if (this.peek() === '<') {
        children.push(this.parseElement());
      } else {
        const text = this.readText();
        if (hasNonWhitespace(text)) textContent += text.trim();
      }
    }
  }

  private readName(): string {
    const start = this.pos;
    while (this.pos < this.xml.length) {
      const c = this.xml.charCodeAt(this.pos);
      const ok =
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        this.xml[this.pos] === '_' ||
        this.xml[this.pos] === '-' ||
        this.xml[this.pos] === '.' ||
        this.xml[this.pos] === ':';
      if (!ok) break;
      this.pos++;
    }
    if (start === this.pos) throw new Error('Expected XML name');
    return this.xml.slice(start, this.pos);
  }

  private readQuotedValue(): string {
    const quote = this.xml[this.pos];
    if (quote !== '"' && quote !== "'") throw new Error('Expected quoted attribute value');
    this.pos++;
    const start = this.pos;
    while (this.pos < this.xml.length && this.xml[this.pos] !== quote) this.pos++;
    if (this.pos >= this.xml.length) throw new Error('Unterminated attribute value');
    const value = this.xml.slice(start, this.pos);
    this.pos++;
    return value;
  }

  private readText(): string {
    const start = this.pos;
    while (this.pos < this.xml.length && this.xml[this.pos] !== '<') this.pos++;
    return this.xml.slice(start, this.pos);
  }

  private skipWs(): void {
    while (this.pos < this.xml.length) {
      const c = this.xml.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.pos++;
      else break;
    }
  }

  private skipUntil(marker: string): void {
    const i = this.xml.indexOf(marker, this.pos);
    if (i < 0) {
      this.pos = this.xml.length;
      return;
    }
    this.pos = i + marker.length;
  }

  private startsWith(s: string): boolean {
    return this.xml.startsWith(s, this.pos);
  }

  private peek(): string {
    return this.xml[this.pos] ?? '';
  }

  private expect(c: string): void {
    if (this.xml[this.pos] !== c) throw new Error(`Expected '${c}'`);
    this.pos++;
  }
}

export function emptyXmlDocument(): LPropList {
  return makeNode('#document', [], [], []);
}

export function parseXmlToLingo(xml: string): LPropList {
  return new XmlParser(xml).parseDocument();
}
