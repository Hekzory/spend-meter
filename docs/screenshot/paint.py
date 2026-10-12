#!/usr/bin/env python3
"""Paints docs/screenshot.png from the pane tree scenario.tsx prints.

The pane is the engine's own drawing (`ui.drawn()`), laid out the way Claude
Code's terminal lays out boxes and text, in its dark theme's colors. The
conversation beside it is a sketch of the same session. Block elements and
rules are drawn as geometry, as Windows Terminal and kitty draw them, so bars
and lines join without seams.

usage: paint.py <tree.json> <out.png>
"""

import base64
import glob
import json
import math
import os
import random
import struct
import sys

from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

S = 2  # pixels per CSS pixel
CW, CH = 9 * S, 20 * S  # one terminal cell

# Claude Code's dark theme, and the terminal around it.
THEME = {
    'claude': (215, 119, 87),
    'subtle': (80, 80, 80),
    'inactive': (153, 153, 153),
    'success': (78, 186, 101),
    'warning': (255, 193, 7),
    'error': (255, 107, 128),
    'text': (255, 255, 255),
    'suggestion': (153, 204, 255),
    'autoAccept': (175, 135, 255),
    'promptBorder': (136, 136, 136),
}
FG = (226, 226, 226)
TERM_BG = (27, 27, 29)
PANE_BG = (38, 38, 38)
PROMPT_BG = (52, 52, 55)
DIM = THEME['inactive']

# ─── fonts ───────────────────────────────────────────────────────────────────

FONT_DIRS = [
    os.environ.get('FONT_DIR', ''),
    os.path.expanduser('~/.local/share/fonts'),
    '/usr/share/fonts',
    *glob.glob('/mnt/c/Users/*/AppData/Local/Microsoft/Windows/Fonts'),
    '/mnt/c/Windows/Fonts',
]


def find_font(*names):
    for name in names:
        for d in FONT_DIRS:
            if d:
                hits = glob.glob(os.path.join(d, '**', name), recursive=True)
                if hits:
                    return hits[0]
    return None


class Face:
    """A font sized so its advance is one cell, and the code points it has."""

    def __init__(self, path, bold=False):
        tt = TTFont(path, fontNumber=0, lazy=True)
        self.cmap = set(tt.getBestCmap())
        upm = tt['head'].unitsPerEm
        adv = tt['hmtx'][tt.getBestCmap()[ord('0')]][0] if ord('0') in self.cmap else upm * 0.6
        self.size = min(CW / (adv / upm), CH * 0.78)
        self.font = ImageFont.truetype(path, self.size)
        if bold and 'fvar' in tt:  # a variable font: pick its bold instance
            try:
                self.font.set_variation_by_name('Bold')
            except Exception:
                pass

    def has(self, ch):
        return ord(ch) in self.cmap


MONO = ['FiraCodeNerdFontMono-{}.ttf', 'FiraCode-{}.ttf', 'JetBrainsMono-{}.ttf', 'CascadiaMono.ttf', 'AdwaitaMono-{}.ttf', 'DejaVuSansMono{}.ttf']


def faces(weight):
    paths = [find_font(n.format(weight if 'DejaVu' not in n else ('-Bold' if weight == 'Bold' else ''))) for n in MONO]
    chain = [Face(p, bold=weight == 'Bold') for p in dict.fromkeys(p for p in paths if p)]
    for extra in ('AdwaitaMono-Regular.ttf', 'seguisym.ttf', 'NotoSansSymbols2-Regular.ttf'):
        p = find_font(extra)
        if p:
            chain.append(Face(p))
    if not chain:
        sys.exit('paint.py: no monospace font found; set FONT_DIR')
    return chain


REGULAR = faces('Regular')
BOLD = faces('Bold')
ASC, DESC = REGULAR[0].font.getmetrics()
BASELINE = (CH - (ASC + DESC)) // 2 + ASC


def ui_font(size, bold=False):
    p = find_font('segoeuib.ttf' if bold else 'segoeui.ttf', 'AdwaitaSans-Regular.ttf', 'DejaVuSans.ttf')
    return ImageFont.truetype(p, size * S)


# ─── the pane's tree, laid out in cells ───────────────────────────────────────


class Cell:
    __slots__ = ('ch', 'fg', 'bg', 'bold')

    def __init__(self, ch=' ', fg=None, bg=None, bold=False):
        self.ch, self.fg, self.bg, self.bold = ch, fg, bg, bold


def color(c):
    if c is None:
        return None
    if isinstance(c, str) and c.startswith('#'):
        return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
    return THEME.get(c)


def kids(n):
    out = []
    for c in n.get('children') or []:
        if isinstance(c, list):
            out += kids({'children': c})
        elif c is None or isinstance(c, bool) or c == '':
            continue
        else:
            out.append(c)
    return out


def styled(n, st):
    """A Text, Button or Link as cells, its nested styles applied."""
    if isinstance(n, (int, float)) and not isinstance(n, bool):
        n = str(n)
    if isinstance(n, str):
        fg = st['fg'] if st['fg'] is not None else (DIM if st['dim'] else FG)
        if st['dim'] and st['fg'] is not None:
            fg = tuple(round(v * 0.6 + b * 0.4) for v, b in zip(st['fg'], PANE_BG))
        return [Cell(ch, fg, st['bg'], st['bold']) for ch in n]
    p = n.get('props') or {}
    st = dict(st)
    if p.get('color') is not None:
        st['fg'] = color(p['color'])
    if p.get('backgroundColor') is not None:
        st['bg'] = color(p['backgroundColor'])
    if p.get('bold'):
        st['bold'] = True
    if p.get('dimColor'):
        st['dim'] = True
    out = []
    if n.get('type') == 'Button' and p.get('hotkey'):
        out += [Cell(c, THEME['claude']) for c in p['hotkey'] + ': ']
    children = kids(n) or [p.get('label', '')]
    for k in children:
        out += styled(k, st)
    return out


def wrap(line, width):
    """Word wrap, as the terminal renderer wraps a Text: at spaces, hard where a word is longer."""
    rows = []
    while len(line) > width:
        cut = max((i for i in range(1, width + 1) if line[i - 1].ch != ' ' and i < len(line) and line[i].ch == ' '), default=width)
        rows.append(line[:cut])
        line = line[cut:]
        while line and line[0].ch == ' ':
            line = line[1:]
    return rows + [line]


def text_rows(n, width):
    cells = styled(n, {'fg': None, 'bg': None, 'bold': False, 'dim': False})
    lines = [[]]
    for c in cells:
        if c.ch == '\n':
            lines.append([])
        else:
            lines[-1].append(c)
    mode = (n.get('props') or {}).get('wrap', 'wrap')
    out = []
    for line in lines:
        if mode.startswith('truncate'):
            out.append(line if len(line) <= width else line[:width - 1] + [Cell('…', line[width - 1].fg)])
        else:
            out += wrap(line, width)
    return out


def lay(n, width):
    """The node as rows of cells at most `width` wide, and its pictures."""
    if isinstance(n, str):
        return text_rows({'type': 'Text', 'children': [n]}, width), []
    t = n.get('type')
    p = n.get('props') or {}
    if t in ('Text', 'Button', 'Link'):
        return text_rows(n, width), []
    if t == 'Raster':
        raw = base64.b64decode(p['cells'])
        words = struct.unpack('<%dI' % (len(raw) // 4), raw)
        cols, nrows = p['columns'], p['rows']

        def rgb(v):
            return None if v & 0x01000000 else ((v >> 16) & 255, (v >> 8) & 255, v & 255)

        return [[Cell(chr(words[(r * cols + c) * 3]), rgb(words[(r * cols + c) * 3 + 1]), rgb(words[(r * cols + c) * 3 + 2])) for c in range(cols)] for r in range(nrows)], []
    if t == 'Image':
        return [[Cell() for _ in range(p['columns'])] for _ in range(p['rows'])], [(0, 0, p)]
    px = p.get('paddingX', 0)
    pl = p.get('paddingLeft', px)
    pr = p.get('paddingRight', px)
    inner = width - pl - pr
    parts = [lay(k, inner) for k in kids(n)]
    rows, pics = [], []
    if p.get('flexDirection') == 'column':
        for r, pi in parts:
            pics += [(y + len(rows), x, q) for y, x, q in pi]
            rows += r
    else:
        widths = [max((len(r) for r in part[0]), default=0) for part in parts]
        gap = p.get('columnGap', p.get('gap', 0))
        if p.get('flexWrap') == 'wrap':
            x, y, line_h = 0, 0, 0
            placed = []
            for (r, pi), w in zip(parts, widths):
                if x > 0 and x + w > inner:
                    x, y, line_h = 0, y + line_h, 0
                placed.append((r, pi, x, y))
                x += w + gap
                line_h = max(line_h, len(r))
            height = y + line_h
            offsets = None
        else:
            height = max((len(r) for r, _ in parts), default=0)
            xs, x = [], 0
            if p.get('justifyContent') == 'space-between' and len(parts) > 1:
                free = max(gap * (len(parts) - 1), inner - sum(widths))
                k = len(parts) - 1
                for i, w in enumerate(widths):
                    xs.append(x)
                    x += w + (free // k + (1 if i < free % k else 0) if i < k else 0)
            else:
                for w in widths:
                    xs.append(x)
                    x += w + gap
            placed = [(r, pi, xx, 0) for (r, pi), xx in zip(parts, xs)]
        rows = [[] for _ in range(height)]
        for r, pi, xx, yy in placed:
            for i, line in enumerate(r):
                row = rows[yy + i]
                while len(row) < xx:
                    row.append(Cell())
                row[xx:xx + len(line)] = line
            pics += [(y + yy, x + xx, q) for y, x, q in pi]
    rows = [[Cell() for _ in range(pl)] + r for r in rows]
    pics = [(y, x + pl, q) for y, x, q in pics]
    top, bottom = p.get('marginTop', 0), p.get('marginBottom', 0)
    return [[] for _ in range(top)] + rows + [[] for _ in range(bottom)], [(y + top, x, q) for y, x, q in pics]


# ─── the conversation beside it: a sketch of the same session ────────────────

GREEN, ORANGE, PURPLE = THEME['success'], THEME['claude'], THEME['autoAccept']
B = 'bold'


def seg(text, fg=None, *flags):
    return (text, fg, B in flags)


def you(*lines):
    return [[seg(('> ' if i == 0 else '  '), DIM), seg(text, (236, 236, 236))] for i, text in enumerate(lines)]


def say(*lines):
    return [[seg('● ' if i == 0 else '  ', FG), seg(text, FG)] for i, text in enumerate(lines)]


def tool(name, arg, result, done=True):
    return [
        [seg('● ', GREEN if done else DIM), seg(name, FG, B), seg(f'({arg})', FG)],
        [seg('  ⎿  ', DIM), seg(result, DIM)],
    ]


SPIN = '⠹'
CONVERSATION = [
    *you('Refactor session handling in src/auth', 'so tokens refresh in one place'),
    [],
    *say("I'll map the auth flow, move token", 'refresh into the session store, then', 'port the token cache onto it.'),
    [],
    *tool('Explore', 'map the auth flow', 'Done (14 tool uses · 6m 15s)'),
    [],
    *tool('Read', 'src/auth/session.ts', 'Read 212 lines'),
    [],
    *tool('Update', 'src/auth/session.ts', '48 additions, 31 removals'),
    [],
    *tool('Update', 'src/auth/refresh.ts', 'Removed the file (64 lines)'),
    [],
    *tool('Task', 'port the token cache', 'Done (22 tool uses · 4m 45s)'),
    [],
    [seg('✻ ', DIM), seg('Conversation compacted', DIM)],
    [],
    *tool('Bash', 'npm test', '182 passed (4.1s)'),
    [],
    *say('Token refresh now lives in', 'SessionStore.refresh(); the three', 'helpers it replaced are gone.'),
    [],
    *you('Review it before I merge'),
    [],
    [seg('● ', DIM), seg('Workflow', FG, B), seg('(review-changes)', FG)],
    [seg('  ⎿  ', DIM), seg('5 agents', DIM)],
    [seg('     ✓ ', GREEN), seg('review:bugs   ', FG), seg('2 findings', DIM)],
    [seg('     ✓ ', GREEN), seg('review:docs   ', FG), seg('clean', DIM)],
    [seg('     ✓ ', GREEN), seg('review:tests  ', FG), seg('1 finding', DIM)],
    [seg(f'     {SPIN} ', ORANGE), seg('review:perf   ', FG), seg('running', DIM)],
    [seg(f'     {SPIN} ', ORANGE), seg('review:api    ', FG), seg('running', DIM)],
    [],
    [seg('✻ ', ORANGE), seg('Reviewing… ', ORANGE), seg('(9m 01s · esc to interrupt)', DIM)],
    [],
]


def prompt_box(width):
    border = THEME['promptBorder']
    return [
        [seg('╭' + '─' * (width - 2) + '╮', border)],
        [seg('│ ', border), seg('> ', FG), seg(' ' * (width - 5)), seg('│', border)],
        [seg('╰' + '─' * (width - 2) + '╯', border)],
        [seg('  ⏵⏵ accept edits on ', PURPLE), seg('(shift+tab to cycle)', DIM)],
    ]


def segs_to_cells(line, bg=None):
    return [Cell(ch, fg if fg is not None else FG, bg, bold) for text, fg, bold in line for ch in text]


# ─── painting ─────────────────────────────────────────────────────────────────

BLOCKS = {0x2588: 8, **{0x2580 + k: k for k in range(1, 8)}}  # lower eighths


def draw_cell(d, x, y, cell, default_bg):
    if cell.bg is not None:
        d.rectangle([x, y, x + CW - 1, y + CH - 1], fill=cell.bg)
    o = ord(cell.ch)
    fg = cell.fg or FG
    if o in BLOCKS:
        h = round(CH * BLOCKS[o] / 8)
        d.rectangle([x, y + CH - h, x + CW - 1, y + CH - 1], fill=fg)
    elif o == 0x2501:  # ━
        d.rectangle([x, y + CH // 2 - S, x + CW - 1, y + CH // 2 + S - 1], fill=fg)
    elif o == 0x2500:  # ─
        d.rectangle([x, y + CH // 2 - S // 2, x + CW - 1, y + CH // 2 + S // 2 - 1 + (S % 2)], fill=fg)
    elif o == 0x2502:  # │
        d.rectangle([x + CW // 2 - S // 2, y, x + CW // 2 + S // 2 - 1 + (S % 2), y + CH - 1], fill=fg)
    elif o in (0x256D, 0x256E, 0x2570, 0x256F):  # rounded corners: the font's, which meet the rules
        draw_glyph(d, x, y, cell.ch, fg, cell.bold)
    elif cell.ch != ' ':
        draw_glyph(d, x, y, cell.ch, fg, cell.bold)


def draw_glyph(d, x, y, ch, fg, bold):
    chain = BOLD if bold else REGULAR
    face = next((f for f in chain if f.has(ch)), chain[-1])
    w = face.font.getlength(ch)
    d.text((x + (CW - w) / 2, y + BASELINE), ch, fill=fg, font=face.font, anchor='ls')


def draw_rows(d, rows, x0, y0, width, bg):
    for r, line in enumerate(rows):
        for c, cell in enumerate(line[:width]):
            draw_cell(d, x0 + c * CW, y0 + r * CH, cell, bg)


def rounded_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def backdrop(w, h):
    """A dark warm-to-indigo field with soft glows in the meter's own colors."""
    small = (w // 8, h // 8)
    img = Image.new('RGB', small)
    px = img.load()
    glows = [((0.12, 0.10), ORANGE, 0.55, 0.45), ((0.95, 0.92), PURPLE, 0.50, 0.38), ((0.95, 0.15), (75, 168, 245), 0.40, 0.18)]
    for j in range(small[1]):
        for i in range(small[0]):
            u, v = i / small[0], j / small[1]
            t = (u + v) / 2
            base = [round(a + (b - a) * t) for a, b in zip((30, 20, 24), (16, 15, 34))]
            for (gx, gy), gc, rad, k in glows:
                dist = math.hypot((u - gx) * w / h, v - gy) / rad
                f = k * math.exp(-dist * dist * 2.2)
                base = [b + (c - b) * f * 0.55 for b, c in zip(base, gc)]
            px[i, j] = tuple(round(min(255, b)) for b in base)
    img = img.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(6))
    # A whisper of grain, so the gradient does not band.
    rnd = random.Random(7)
    noise = Image.frombytes('L', (w, h), bytes(rnd.randrange(124, 132) for _ in range(w * h)))
    return ImageChops.add(img, Image.merge('RGB', (noise, noise, noise)), 1.0, -128)


def title_bar(win, width):
    """Windows Terminal's tab row, dark."""
    bar_h = 40 * S
    d = ImageDraw.Draw(win)
    d.rectangle([0, 0, width, bar_h], fill=(32, 32, 34))
    tab_x, tab_w = 10 * S, 230 * S
    d.rounded_rectangle([tab_x, 7 * S, tab_x + tab_w, bar_h + 8 * S], radius=7 * S, fill=TERM_BG)
    draw_glyph(d, tab_x + 12 * S, 7 * S + (bar_h - 7 * S - CH) // 2, '✻', ORANGE, False)
    f = ui_font(12)
    d.text((tab_x + 12 * S + CW + 8 * S, 7 * S + (bar_h - 7 * S) // 2), 'claude · ~/src/app', fill=(214, 214, 214), font=f, anchor='lm')
    cx = tab_x + tab_w - 18 * S
    cy = 7 * S + (bar_h - 7 * S) // 2
    for a, b in (((-4, -4), (4, 4)), ((-4, 4), (4, -4))):
        d.line([cx + a[0] * S, cy + a[1] * S, cx + b[0] * S, cy + b[1] * S], fill=(150, 150, 150), width=S)
    px = tab_x + tab_w + 20 * S
    d.line([px - 5 * S, cy, px + 5 * S, cy], fill=(170, 170, 170), width=S)
    d.line([px, cy - 5 * S, px, cy + 5 * S], fill=(170, 170, 170), width=S)
    vx = px + 26 * S
    d.line([vx - 4 * S, cy - 2 * S, vx, cy + 2 * S, vx + 4 * S, cy - 2 * S], fill=(170, 170, 170), width=S)
    # minimize, maximize, close
    rx = width - 23 * S
    d.line([rx - 5 * S, cy - 5 * S, rx + 5 * S, cy + 5 * S], fill=(200, 200, 200), width=S)
    d.line([rx - 5 * S, cy + 5 * S, rx + 5 * S, cy - 5 * S], fill=(200, 200, 200), width=S)
    rx -= 46 * S
    d.rectangle([rx - 5 * S, cy - 5 * S, rx + 5 * S, cy + 5 * S], outline=(200, 200, 200), width=S)
    rx -= 46 * S
    d.line([rx - 5 * S, cy, rx + 5 * S, cy], fill=(200, 200, 200), width=S)
    return bar_h


def main():
    tree = json.load(open(sys.argv[1]))
    out = sys.argv[2]

    PANE_COLS = 44  # the dock's width
    TALK_COLS = 42
    pane_rows, pics = lay(tree, PANE_COLS)
    while pane_rows and not pane_rows[-1]:
        pane_rows.pop()

    rows = 1 + len(pane_rows) + 1  # the close button's row, the body, a margin
    talk = [segs_to_cells(line) for line in CONVERSATION] + [segs_to_cells(line) for line in prompt_box(TALK_COLS)]
    room = rows - 1  # a blank row under the mode line
    talk = [[] for _ in range(room - len(talk))] + talk if len(talk) <= room else talk[len(talk) - room:]

    left_pad, mid_gap = 2, 2
    cols = left_pad + TALK_COLS + mid_gap + 1 + PANE_COLS
    term_w, term_h = cols * CW, rows * CH

    win_bar = 40 * S
    win_w, win_h = term_w, win_bar + term_h
    win = Image.new('RGB', (win_w, win_h), TERM_BG)
    title_bar(win, win_w)
    term = Image.new('RGB', (term_w, term_h), TERM_BG)
    d = ImageDraw.Draw(term)

    # The conversation.
    tx = left_pad * CW
    for r, line in enumerate(talk):
        y = r * CH
        is_prompt = bool(line) and line[0].ch in '> ' and any(c.fg == (236, 236, 236) for c in line)
        if is_prompt:
            d.rectangle([tx - CW, y, tx + TALK_COLS * CW, y + CH - 1], fill=PROMPT_BG)
        for c, cell in enumerate(line[:TALK_COLS]):
            draw_cell(d, tx + c * CW, y, cell, TERM_BG)

    # The pane: its ground, the rule down its left edge, the close button.
    px0 = (left_pad + TALK_COLS + mid_gap) * CW
    d.rectangle([px0, 0, term_w, term_h], fill=PANE_BG)
    d.rectangle([px0 + CW // 2 - S, 0, px0 + CW // 2, term_h], fill=THEME['suggestion'])
    body_x = px0 + CW
    cx, cy, k = body_x + (PANE_COLS - 2) * CW + CW // 2, CH // 2, 5 * S
    for a, b in (((-k, -k), (k, k)), ((-k, k), (k, -k))):
        d.line([cx + a[0], cy + a[1], cx + b[0], cy + b[1]], fill=(120, 120, 120), width=S)
    draw_rows(d, pane_rows, body_x, CH, PANE_COLS, PANE_BG)
    for r, c, p in pics:
        src = p['source']
        if 'rgba' in src:
            pic = Image.frombytes('RGBA', (src['width'], src['height']), base64.b64decode(src['rgba']))
            pic = pic.resize((p['columns'] * CW, p['rows'] * CH), Image.LANCZOS)
            term.paste(pic, (body_x + c * CW, CH + r * CH), pic)

    win.paste(term, (0, win_bar))
    ImageDraw.Draw(win).line([0, win_bar, win_w, win_bar], fill=(44, 44, 46), width=S)

    # The window on its backdrop, with a soft shadow and a hairline edge.
    margin = 64 * S
    canvas_w, canvas_h = win_w + 2 * margin, win_h + 2 * margin
    canvas = backdrop(canvas_w, canvas_h)
    radius = 10 * S
    shadow = Image.new('L', (canvas_w, canvas_h), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([margin, margin + 18 * S, margin + win_w, margin + win_h + 18 * S], radius=radius, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28 * S))
    canvas.paste(Image.new('RGB', (canvas_w, canvas_h), (4, 4, 8)), (0, 0), shadow)
    canvas.paste(win, (margin, margin), rounded_mask((win_w, win_h), radius))
    ImageDraw.Draw(canvas).rounded_rectangle([margin, margin, margin + win_w - 1, margin + win_h - 1], radius=radius, outline=(70, 70, 76), width=1)
    # 256 colors, dithered: half the bytes, and no difference a reader can see.
    canvas.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)
    print(out, canvas.size)


if __name__ == '__main__':
    main()
