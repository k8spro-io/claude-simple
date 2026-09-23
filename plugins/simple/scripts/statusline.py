#!/usr/bin/env python3
"""Claude Code status line.

Line 1 — where I am:    dir · branch ↑↓ · branch diff · dirty files · PR
Line 2 — what it costs: model/effort · context bar · cache · $ · 5h/7d limits · 7d per model

Weekly per-model usage comes from statusline-weekly.py, refreshed in the background and never
blocking the render. Everything else comes from the payload Claude Code writes to stdin.
"""
import json, os, subprocess, sys, time

HOME = os.path.expanduser('~')
WEEKLY = os.path.join(HOME, '.claude', 'statusline-weekly.json')
REFRESH = os.path.join(HOME, '.claude', 'statusline-weekly.py')
LOCK = os.path.join(HOME, '.claude', '.statusline-weekly.lock')
MAX_AGE = 120  # s

R = '\033[0m'
def c(code, s): return f'\033[{code}m{s}{R}'
BOLD, DIM = '1', '2'
GREEN, YELLOW, RED, BLUE, CYAN, MAG, GREY = '32', '33', '31', '34', '36', '35', '90'

def sh(args, cwd=None, timeout=1.5):
    try:
        out = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return out.stdout.strip() if out.returncode == 0 else ''
    except Exception:
        return ''

def human(n):
    n = float(n)
    for lim, suf in ((1e9, 'B'), (1e6, 'M'), (1e3, 'k')):
        if n >= lim:
            v = n / lim
            return f'{v:.1f}{suf}' if v < 10 else f'{v:.0f}{suf}'
    return str(int(n))

def dur(seconds):
    seconds = max(0, int(seconds))
    d, rem = divmod(seconds, 86400)
    h, m = divmod(rem // 60, 60)
    if d: return f'{d}d{h}h'
    if h: return f'{h}h{m:02d}m'
    return f'{m}m'

def compact_budget(data):
    """Tokens until auto-compact: autoCompactWindow from settings, else the model window."""
    win = None
    for p in (os.path.join(data.get('workspace', {}).get('project_dir', ''), '.claude', 'settings.json'),
              os.path.join(HOME, '.claude', 'settings.json')):
        try:
            with open(p) as f:
                v = json.load(f).get('autoCompactWindow')
            if isinstance(v, int):
                win = v
                break
        except Exception:
            continue
    size = data.get('context_window', {}).get('context_window_size') or 200000
    if not win:
        win = size
    return min(win, size)

def git_block(cwd):
    if not cwd or not sh(['git', 'rev-parse', '--is-inside-work-tree'], cwd=cwd):
        return ''
    branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=cwd) or '?'
    icon = '\uf418 ' if os.environ.get('STATUSLINE_NERD') else ''
    parts = [c('1;' + MAG, icon + branch)]

    counts = sh(['git', 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'], cwd=cwd)
    if counts and '\t' in counts:
        behind, ahead = counts.split('\t')[:2]
        tail = ''
        if ahead != '0': tail += c(GREEN, f'↑{ahead}')
        if behind != '0': tail += c(RED, f'↓{behind}')
        if tail: parts.append(tail)

    # branch diff: this branch against its base (origin/main), plus what is not committed yet
    base = ''
    for ref in ('origin/main', 'origin/master', 'main', 'master'):
        base = sh(['git', 'merge-base', ref, 'HEAD'], cwd=cwd)
        if base: break
    add = rem = 0
    for stat in (sh(['git', 'diff', '--shortstat', base, 'HEAD'], cwd=cwd) if base else '',
                 sh(['git', 'diff', '--shortstat', 'HEAD'], cwd=cwd)):
        for tok in stat.split(','):
            tok = tok.strip()
            if 'insertion' in tok: add += int(tok.split()[0])
            elif 'deletion' in tok: rem += int(tok.split()[0])
    if add or rem:
        parts.append(c(GREEN, f'+{add}') + '/' + c(RED, f'-{rem}'))

    dirty = sh(['git', 'status', '--porcelain', '-uno'], cwd=cwd)
    n = len([l for l in dirty.splitlines() if l.strip()])
    if n:
        parts.append(c(YELLOW, f'✱{n}'))
    return ' '.join(parts)

def weekly_models():
    data, age = {}, 1e9
    try:
        st = os.stat(WEEKLY)
        age = time.time() - st.st_mtime
        with open(WEEKLY) as f:
            data = json.load(f)
    except Exception:
        pass
    if age > MAX_AGE:  # refresh in the background; never block the render
        try:
            if not os.path.exists(LOCK) or time.time() - os.stat(LOCK).st_mtime > 60:
                open(LOCK, 'w').close()
                subprocess.Popen([sys.executable, REFRESH], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception:
            pass
    by = {k: v for k, v in (data.get('by_model') or {}).items() if v}
    if not by:
        return ''
    def label(m):
        for key, name in (('opus', 'Opus'), ('fable', 'Fable'), ('sonnet', 'Sonnet'), ('haiku', 'Haiku')):
            if key in m:
                return name
        base = m.split('/')[-1].split('-')[0]
        return base[:1].upper() + base[1:8]
    top = sorted(by.items(), key=lambda kv: -kv[1])[:3]
    return ' '.join(f'{label(m)} {human(t)}' for m, t in top)

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print('statusline: invalid json'); return

    cwd = data.get('workspace', {}).get('current_dir') or data.get('cwd') or ''
    repo = data.get('workspace', {}).get('repo') or {}
    label = repo.get('name') or os.path.basename(cwd) or cwd
    proj = data.get('workspace', {}).get('project_dir') or ''
    sub = os.path.relpath(cwd, proj) if proj and cwd.startswith(proj) else ''
    if sub and sub != '.':
        label = f'{label}/{sub}'

    # ---------- line 1: where I am ----------
    l1 = [c('1;' + BLUE, label)]
    wt = data.get('worktree') or {}
    if wt.get('name'):
        l1.append(c(CYAN, f"⎇ {wt['name']}"))
    g = git_block(cwd)
    if g:
        l1.append(g)
    pr = data.get('pr') or {}
    if pr.get('number'):
        mark = {'approved': c(GREEN, '✓'), 'changes_requested': c(RED, '✗'),
                'pending': c(YELLOW, '○'), 'draft': c(GREY, '◌')}.get(pr.get('review_state'), '')
        l1.append(c(CYAN, f"PR #{pr['number']}") + (' ' + mark if mark else ''))
    agent = (data.get('agent') or {}).get('name')
    if agent:
        l1.append(c(GREY, f'@{agent}'))

    # ---------- line 2: what it costs ----------
    model = data.get('model', {}).get('display_name', '?')
    model = model.replace(' (1M context)', ' 1M').replace(' (', ' ').replace(')', '')
    eff = (data.get('effort') or {}).get('level')
    head = c(BOLD, model) + (c(GREY, f' · {eff}') if eff else '')
    if data.get('fast_mode'):
        head += c(YELLOW, ' ⚡')
    l2 = [head]

    ctx = data.get('context_window') or {}
    used = (ctx.get('total_input_tokens', 0) or 0) + (ctx.get('total_output_tokens', 0) or 0)
    win = compact_budget(data)
    frac = min(1.0, used / win) if win else 0
    filled = int(round(frac * 10))
    color = GREEN if frac < 0.5 else (YELLOW if frac < 0.85 else RED)
    bar = c(color, '▓' * filled) + c(GREY, '░' * (10 - filled))
    tail = c(RED, ' compact') if frac >= 0.85 else ''
    l2.append(f'{bar} {c(color, human(used))}{c(GREY, "/" + human(win))}{tail}')

    pc = data.get('prompt_cache') or {}
    if pc.get('hit_ratio') is not None:
        hr = pc['hit_ratio'] * 100
        l2.append(c(GREY, 'cache ') + c(GREEN if hr >= 70 else YELLOW, f'{hr:.0f}%'))

    usd = (data.get('cost') or {}).get('total_cost_usd')
    if usd is not None:
        l2.append(c(GREEN if usd < 5 else YELLOW, f'${usd:.2f}'))

    rl = data.get('rate_limits') or {}
    chunk = []
    for key, tag in (('five_hour', '5h'), ('seven_day', '7d')):
        b = rl.get(key) or {}
        p = b.get('used_percentage')
        if p is None:
            continue
        col = GREEN if p < 50 else (YELLOW if p < 80 else RED)
        txt = f'{tag} ' + c(col, f'{p:.0f}%')
        if key == 'seven_day' and b.get('resets_at'):
            txt += c(GREY, f' ↻{dur(b["resets_at"] - time.time())}')
        chunk.append(txt)
    if chunk:
        l2.append(' '.join(chunk))

    wk = weekly_models()
    if wk:
        l2.append(c(GREY, '7d ' + wk))

    sep = c(GREY, ' │ ')
    print(sep.join(l1))
    print(sep.join(l2))

main()
