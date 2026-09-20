#!/usr/bin/env python3
"""Aggregate token usage per model over the last 7 days from Claude Code transcripts.

Incremental: remembers each transcript's byte offset, so only new lines are parsed.
Writes ~/.claude/statusline-weekly.json  -> {"updated":ts,"by_model":{id:tokens},"since":date}
"""
import json, os, sys, time, glob

HOME = os.path.expanduser('~')
CACHE = os.path.join(HOME, '.claude', 'statusline-weekly.json')
STATE = os.path.join(HOME, '.claude', 'statusline-weekly-state.json')
WINDOW = 7 * 86400

def load(p, d):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return d

def main():
    now = time.time()
    cutoff = now - WINDOW
    state = load(STATE, {})
    daily = state.get('daily', {})          # {"YYYY-MM-DD": {model: tokens}}
    offsets = state.get('offsets', {})      # {path: [size, inode]}
    root = os.path.join(HOME, '.claude', 'projects')
    paths = []
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.endswith('.jsonl'):
                paths.append(os.path.join(dirpath, fn))
    for path in paths:
        try: st = os.stat(path)
        except OSError: continue
        if st.st_mtime < cutoff and path in offsets: continue
        prev = offsets.get(path)
        start = 0
        if prev and prev[1] == st.st_ino and prev[0] <= st.st_size:
            start = prev[0]
        if start == st.st_size: continue
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                data = f.read()
        except OSError: continue
        consumed = start
        for raw in data.split(b'\n'):
            consumed += len(raw) + 1
            if not raw.strip(): continue
            try: rec = json.loads(raw)
            except Exception: continue
            msg = rec.get('message')
            if not isinstance(msg, dict): continue
            usage = msg.get('usage')
            if not isinstance(usage, dict): continue
            model = msg.get('model') or 'unknown'
            ts = (rec.get('timestamp') or '')[:10]
            if not ts: continue
            tok = (usage.get('input_tokens', 0) + usage.get('output_tokens', 0)
                   + usage.get('cache_creation_input_tokens', 0)
                   + usage.get('cache_read_input_tokens', 0))
            daily.setdefault(ts, {})
            daily[ts][model] = daily[ts].get(model, 0) + tok
        offsets[path] = [min(consumed, st.st_size), st.st_ino]
    keep = time.strftime('%Y-%m-%d', time.localtime(cutoff))
    daily = {d: v for d, v in daily.items() if d >= keep}
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f: json.dump({'daily': daily, 'offsets': offsets}, f)
    os.replace(tmp, STATE)
    by_model = {}
    for v in daily.values():
        for m, t in v.items(): by_model[m] = by_model.get(m, 0) + t
    tmp = CACHE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'updated': int(now), 'since': keep, 'by_model': by_model}, f)
    os.replace(tmp, CACHE)
    print(json.dumps({'since': keep, 'by_model': by_model}, indent=2))

main()
