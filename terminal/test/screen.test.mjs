import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';
import { Screen } from '../screen.mjs';

// Consume the emitted VT cursor/mode controls, including right-margin wrapping,
// instead of treating a stripped CRLF string as the terminal's physical rows.
function terminal(columns, rows, wrapTiming = 'deferred') {
  const grid = {
    row: 0, column: 0, wrap: true, pendingWrap: false, cursorVisible: true, alternate: false, scrolls: 0,
    cells: Array.from({ length: rows }, () => Array(columns).fill(' ')),
    lineFeed() {
      if (this.row < rows - 1) this.row++;
      else { this.cells.shift(); this.cells.push(Array(columns).fill(' ')); this.scrolls++; }
    },
    write(value) {
      for (const token of value.match(/\x1b\[[?\d;]*[A-Za-z]|[^\x1b]+/gu) || []) {
        const control = token.match(/^\x1b\[(\??)([\d;]*)([A-Za-z])$/u);
        if (control) {
          const [, privateMode, parameters, command] = control;
          const numbers = parameters.split(';').map(Number);
          if (command === 'H') {
            this.row = Math.max(0, Math.min(rows - 1, (numbers[0] || 1) - 1));
            this.column = Math.max(0, Math.min(columns - 1, (numbers[1] || 1) - 1));
            this.pendingWrap = false;
          } else if (privateMode && ['h', 'l'].includes(command)) {
            if (numbers[0] === 7) { this.wrap = command === 'h'; this.pendingWrap = false; }
            if (numbers[0] === 25) this.cursorVisible = command === 'h';
            if (numbers[0] === 1049) this.alternate = command === 'h';
          } else if (command === 'J' && numbers[0] === 2) {
            this.cells = Array.from({ length: rows }, () => Array(columns).fill(' '));
          }
          continue;
        }
        for (const part of token.split(/([\r\n])/u)) {
          if (part === '\r') { this.column = 0; this.pendingWrap = false; continue; }
          if (part === '\n') { this.lineFeed(); this.pendingWrap = false; continue; }
          for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part)) {
            const size = stringWidth(segment);
            if (this.wrap && (this.pendingWrap || this.column + size > columns)) { this.column = 0; this.lineFeed(); }
            this.pendingWrap = false;
            for (let cell = 0; cell < size && this.column + cell < columns; cell++) this.cells[this.row][this.column + cell] = cell ? '' : segment;
            this.column += size;
            if (this.column >= columns) {
              this.column = columns - 1;
              if (this.wrap && wrapTiming === 'immediate') { this.column = 0; this.lineFeed(); }
              else this.pendingWrap = this.wrap;
            }
          }
        }
      }
    },
  };
  const input = new EventEmitter();
  Object.assign(input, { setEncoding() {}, setRawMode(value) { this.raw = value; }, resume() {}, pause() {} });
  return { grid, input, output: { columns, rows, write: (value) => grid.write(value) } };
}

test('80×24 redraws on every input preserve the frame and position the real editing cursor', () => {
  for (const timing of ['immediate', 'deferred']) {
    const io = terminal(80, 24, timing);
    let value = '';
    const draw = () => screen.draw({ title: 'AlphaCouncil', rows: [{ text: '股票代码' }, {}, { text: value }], cursor: { row: 2, column: 2 + stringWidth(value) } });
    const screen = new Screen((event) => { if (event.key === 'text') value += event.text; draw(); }, io);
    screen.start(); draw();
    for (const character of 'AAPL中文123') io.input.emit('data', character);
    assert.equal(io.grid.scrolls, 0, timing);
    assert.equal(io.grid.cells[0].join(''), '+' + '-'.repeat(78) + '+');
    assert.equal(io.grid.cells[23].join(''), '+' + '-'.repeat(78) + '+');
    assert.equal(io.grid.cells[6].slice(4, 4 + stringWidth(value)).join(''), value);
    assert.equal(io.grid.row, 6);
    assert.equal(io.grid.column, 4 + stringWidth(value));
    assert.equal(io.grid.cursorVisible, true);
    assert.equal(io.grid.pendingWrap, false);
    assert.equal(io.grid.wrap, true);
    screen.draw({ title: 'Next screen' });
    assert.equal(io.grid.cursorVisible, false);
    assert.deepEqual([io.grid.row, io.grid.column], [0, 0]);
    screen.stop();
    assert.equal(io.grid.cursorVisible, true);
    assert.equal(io.grid.wrap, true);
    assert.equal(io.grid.alternate, false);
    assert.equal(io.input.raw, false);
  }
});

test('the repository logo changes only the startup header and its physical click rows', () => {
  const io = terminal(80, 24, 'immediate');
  const screen = new Screen(() => {}, io);
  const rows = [{ text: 'English', action() {} }];
  assert.equal(screen.draw({ title: 'AlphaCouncil', subtitle: 'Language', rows, showLogo: true }).visible, 15);
  assert.match(io.grid.cells[1].join(''), /⢀⡤⠶⣄⣠/u);
  assert.ok(io.grid.cells[3].join('').includes('github.com/Zhao73/alphacouncil-agent'));
  assert.equal(screen.hits[0].y, 6);
  assert.equal(screen.draw({ title: 'Ticker', rows }).visible, 16);
  assert.equal(screen.hits[0].y, 5);
  assert.doesNotMatch(io.grid.cells.flat().join(''), /⢀⡤⠶⣄⣠|github\.com/u);
  assert.equal(io.grid.scrolls, 0);
});

test('a long input caret stays inside the content pane and never reaches the bottom border', () => {
  const io = terminal(120, 36);
  const screen = new Screen(() => {}, io);
  screen.draw({ title: 'Details', navigation: [{ text: 'History', action() {} }], cursor: { row: 999, column: 999 } });
  assert.deepEqual([io.grid.row, io.grid.column], [31, 117]);
  assert.equal(io.grid.scrolls, 0);
  io.output.columns = 79;
  screen.draw({ title: 'Small', smallTerminal: 'Resize', cursor: { row: 2, column: 3 } });
  assert.equal(io.grid.cursorVisible, false);
});
