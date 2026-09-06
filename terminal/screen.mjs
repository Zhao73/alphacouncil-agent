import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LOGO = [' ⢀⡤⠶⣄⣠    ⢀⡀⢠⠞', '⣰⠋  ⣸⠃  ⣠⣠⠎⠙⠃ ', '⢧⣀⡤⠞⠉⠦⠤⠊      '];
export function cleanText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '    ');
}
export function clip(value, columns) {
  let result = '', used = 0;
  for (const { segment } of graphemes.segment(cleanText(value).replace(/\r?\n/g, ' '))) {
    const size = stringWidth(segment);
    if (used + size > columns) break;
    result += segment;
    used += size;
  }
  return result + ' '.repeat(Math.max(0, columns - used));
}
export function wrapText(value, columns) {
  const output = [];
  for (const line of cleanText(value).split(/\r?\n/)) {
    let row = '', used = 0;
    for (const { segment } of graphemes.segment(line)) {
      const size = stringWidth(segment);
      if (used + size > columns && row) { output.push(row); row = ''; used = 0; }
      row += segment; used += size;
    }
    output.push(row);
  }
  return output;
}

// SGR mouse, bracketed paste and normal keys share one stream, so paste is never a command.
export function inputDecoder(onInput) {
  let buffer = '', escapeTimer;
  function consume(flushEscape = false) {
    clearTimeout(escapeTimer);
    while (buffer) {
      if (buffer.startsWith('\x1b[200~')) {
        const end = buffer.indexOf('\x1b[201~');
        if (end < 0) {
          if (buffer.length > 128 * 1024) buffer = '';
          return;
        }
        onInput({ key: 'paste', text: cleanText(buffer.slice(6, end)).replace(/[\r\n]/g, ' ') });
        buffer = buffer.slice(end + 6); continue;
      }
      const mouse = buffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (mouse) {
        buffer = buffer.slice(mouse[0].length);
        const button = Number(mouse[1]);
        if (mouse[4] === 'M') onInput({ key: button & 64 ? (button & 1 ? 'down' : 'up') : 'mouse', button: button & 3, x: Number(mouse[2]), y: Number(mouse[3]) });
        continue;
      }
      const sequence = buffer.match(/^\x1b(?:\[|O)(?:\d+(?:;\d+)*)?([A-Z~])/);
      if (sequence) {
        const map = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shiftTab' };
        const key = map[sequence[1]] || ({ '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown', '\x1b[3~': 'delete' })[sequence[0]];
        buffer = buffer.slice(sequence[0].length);
        if (key) onInput({ key });
        continue;
      }
      if (buffer[0] === '\x1b') {
        if (!flushEscape && (buffer.length === 1 || /^\x1b\[<?[\d;]*$/.test(buffer))) {
          escapeTimer = setTimeout(() => consume(true), 60); return;
        }
        buffer = buffer.slice(1); onInput({ key: 'escape' }); continue;
      }
      const char = String.fromCodePoint(buffer.codePointAt(0));
      buffer = buffer.slice(char.length);
      const key = ({ '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace', '\x03': 'interrupt' })[char];
      if (key) onInput({ key });
      else if (char >= ' ') onInput({ key: 'text', text: char });
    }
  }
  return { write(chunk) { buffer += chunk; consume(); }, close() { clearTimeout(escapeTimer); buffer = ''; } };
}

export class Screen {
  constructor(onInput, { input = process.stdin, output = process.stdout } = {}) {
    this.input = input; this.output = output;
    this.decoder = inputDecoder(onInput);
    this.onData = (chunk) => this.decoder.write(chunk);
    this.color = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  }
  start() {
    this.input.setEncoding('utf8');
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on('data', this.onData);
    this.output.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h');
  }
  stop() {
    this.input.removeListener('data', this.onData);
    this.decoder.close();
    this.input.setRawMode(false);
    this.input.pause();
    this.output.write('\x1b[0m\x1b[?7h\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }
  draw({ title, subtitle = '', rows = [], selected = 0, offset = 0, footer = '', message = '', navigation = [], smallTerminal = '', cursor = null, showLogo = false }) {
    const width = this.output.columns || 80, height = this.output.rows || 24;
    this.hits = [];
    if (width < 80 || height < 24) {
      this.output.write('\x1b[?25l\x1b[H\x1b[2J' + clip(smallTerminal, Math.max(1, width - 1)));
      return { visible: 0, offset: 0 };
    }
    const wide = width >= 120 && navigation.length > 0;
    const navWidth = wide ? 21 : 0;
    const contentWidth = width - 4 - navWidth;
    const headerHeight = showLogo ? 5 : 4;
    const visible = height - headerHeight - 4;
    offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - visible)));
    const border = '+' + '-'.repeat(width - 2) + '+';
    const heading = showLogo
      ? [title, subtitle, 'github.com/Zhao73/alphacouncil-agent'].map((text, i) => '| ' + clip(LOGO[i], 14) + '  ' + clip(text, width - 20) + ' |')
      : ['| ' + clip(title, width - 4) + ' |', '| ' + clip(subtitle, width - 4) + ' |'];
    const frame = [border, ...heading, border];
    for (let i = 0; i < visible; i++) {
      const index = i + offset, row = rows[index];
      const isSelected = index === selected && row?.action;
      const content = clip(`${isSelected ? '> ' : '  '}${row?.text || ''}`, contentWidth);
      const highlight = isSelected && this.color ? '\x1b[7m' : '';
      let left = '';
      if (wide) {
        left = clip(navigation[i]?.text || '', 20) + '|';
        if (navigation[i]) this.hits.push({ x1: 2, x2: 21, y: i + headerHeight + 1, action: navigation[i].action });
      }
      frame.push('| ' + left + highlight + content + (highlight ? '\x1b[0m' : '') + ' |');
      if (row?.action) this.hits.push({ x1: 3 + navWidth, x2: width - 2, y: i + headerHeight + 1, action: row.action, index });
    }
    frame.push(border, '| ' + clip(message, width - 4) + ' |', '| ' + clip(footer, width - 4) + ' |', border);
    const styled = frame.map((line, i) => this.color && (i < headerHeight || i >= frame.length - 4) ? '\x1b[36m' + line + '\x1b[0m' : line);
    const caret = cursor
      ? `${headerHeight + 1 + Math.max(0, Math.min(cursor.row, visible - 1))};${3 + navWidth + Math.max(0, Math.min(cursor.column, contentWidth - 1))}`
      : '1;1';
    this.output.write('\x1b[?25l\x1b[?7l\x1b[H' + styled.join('\r\n') + `\x1b[${caret}H\x1b[?7h` + (cursor ? '\x1b[?25h' : ''));
    return { visible, offset };
  }
}
