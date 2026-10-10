#!/usr/bin/env python3
"""Aggregate token usage per model over the last 7 days from Claude Code transcripts.

Reads <config>/projects/**/*.jsonl incrementally and prints one JSON object, also cached in
<config>/simple/statusline-weekly.json:

    {"updated": <epoch s>, "since": "<UTC hour, YYYY-MM-DDTHH>", "by_model": {"<model id>": <tokens>}}

<config> is $CLAUDE_CONFIG_DIR, else ~/.claude. The window is the UTC hour buckets from the hour of
now-7d on.

    statusline-weekly.py [--max-age SECONDS] [--now EPOCH]

--max-age: print the cache without scanning when it is younger than this (default 120).
--now: clock override, for tests. Exit 0 on success; 75 when another run holds the lock and there is no
cache to print yet.

The state (<config>/simple/statusline-weekly-state.json) keeps, per transcript, its inode, size and the
byte offset of the next unread line, the open response (last_*) and the tokens per UTC hour and model, so
a run only parses what was appended. Claude Code writes one line per content block of a response, each
with the usage known at that point (output tokens grow), so a response counts once, with its last
block's usage. A response is keyed by message.id + requestId within one file; a session copied into
another file (a fork) counts again there.
"""
import argparse, errno, json, os, re, sys, tempfile, time
try:
    import fcntl
except ImportError:  # no flock on this platform: run without the cross-process lock
    fcntl = None

WINDOW = 7 * 86400
VERSION = 1  # of the state layout and counting rules; a state with another one is rebuilt
BUSY = 75    # EX_TEMPFAIL
FIELDS = ('input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')
HOUR = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}')

def warn(msg):
    print('statusline-weekly: ' + msg, file=sys.stderr)

def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

def write_json(path, obj):
    """Atomic: write a unique temp file next to the target, then rename it over."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=os.path.basename(path) + '.',
                               suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f, sort_keys=True, separators=(',', ':'))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def read_cache(path, now):
    """(cache, age in seconds), or (None, None) when it is missing, unreadable or not ours."""
    try:
        age = now - os.stat(path).st_mtime
    except OSError:
        return None, None
    c = read_json(path)
    if (isinstance(c, dict) and type(c.get('updated')) is int and isinstance(c.get('since'), str)
            and isinstance(c.get('by_model'), dict)
            and all(type(v) is int for v in c['by_model'].values())):
        return {k: c[k] for k in ('updated', 'since', 'by_model')}, age
    return None, None

def emit(obj):
    print(json.dumps(obj, sort_keys=True, separators=(',', ':')))
    return 0

def sane(e):
    try:
        return (all(type(e[k]) is int for k in ('inode', 'size', 'offset', 'last_tokens'))
                and 0 <= e['offset'] <= e['size']
                and (e['last_key'] is None or isinstance(e['last_key'], list))
                and isinstance(e['last_hour'], str) and isinstance(e['last_model'], str)
                and all(isinstance(m, dict) and all(type(t) is int for t in m.values())
                        for m in e['buckets'].values()))
    except (KeyError, TypeError, AttributeError):
        return False

def load_state(path, since):
    """Per-transcript entries of the last run; {} when there is no usable state."""
    data = read_json(path)
    if (not isinstance(data, dict) or data.get('version') != VERSION
            or not isinstance(data.get('files'), dict) or not isinstance(data.get('since'), str)
            or data['since'] > since):
        return {}  # a later window start means the clock went back: the hours pruned since are gone
    return {p: e for p, e in data['files'].items() if sane(e)}

def parse(raw):
    """(key, hour, model, tokens) of a transcript line that carries usage, else None."""
    try:
        rec = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    msg = rec.get('message') if isinstance(rec, dict) else None
    if not isinstance(msg, dict) or not isinstance(msg.get('usage'), dict):
        return None
    ts = rec.get('timestamp')
    if not isinstance(ts, str) or not HOUR.match(ts):
        return None
    model = msg.get('model')
    tokens = 0
    for k in FIELDS:
        n = msg['usage'].get(k)
        if type(n) is int and n > 0:  # null, non-integer and negative counts are 0
            tokens += n
    key = [msg['id'], rec.get('requestId')] if msg.get('id') else None  # no id, no dedupe
    return key, ts[:13], model if isinstance(model, str) and model else 'unknown', tokens

def add(buckets, hour, model, tokens, since):
    if tokens > 0 and hour >= since:
        b = buckets.setdefault(hour, {})
        b[model] = b.get(model, 0) + tokens

def scan(path, prev, since):
    """The transcript's new state entry: parses only the complete lines appended since `prev`."""
    with open(path, 'rb') as f:
        st = os.fstat(f.fileno())
        if prev is None or prev['inode'] != st.st_ino or st.st_size < prev['size']:
            # new, replaced or truncated: nothing counted before applies
            prev = {'inode': st.st_ino, 'offset': 0, 'last_key': None, 'last_hour': '', 'last_model': '',
                    'last_tokens': 0, 'buckets': {}}
        ent = dict(prev)
        buckets = ent['buckets'] = {h: dict(m) for h, m in prev['buckets'].items()}
        pos = ent['offset']
        f.seek(pos)
        for raw in f:
            if raw[-1:] != b'\n':
                break  # still being written: it counts once it is complete
            pos += len(raw)
            if b'"usage"' not in raw:
                continue  # most lines: skip without parsing
            hit = parse(raw)
            if hit is None:
                continue
            key, hour, model, tokens = hit
            if key is not None and key == ent['last_key']:
                # a later block of the same response: its usage is the more complete one
                if tokens > ent['last_tokens']:
                    add(buckets, ent['last_hour'], ent['last_model'], tokens - ent['last_tokens'], since)
                    ent['last_tokens'] = tokens
                continue
            add(buckets, hour, model, tokens, since)
            ent.update(last_key=key, last_hour=hour, last_model=model, last_tokens=tokens)
        ent['offset'] = pos
        ent['size'] = f.tell()
    return ent

def refresh(config, now):
    """Scan the transcripts, persist the state and the cache, return the cache object."""
    base = os.path.join(config, 'simple')
    root = os.path.join(config, 'projects')
    cutoff = (int(now) - WINDOW) // 3600 * 3600  # start of the oldest hour in the window
    since = time.strftime('%Y-%m-%dT%H', time.gmtime(cutoff))
    state_path = os.path.join(base, 'statusline-weekly-state.json')
    old = load_state(state_path, since)
    new = {}
    listed = True  # False once a directory could not be read: files we did not see may still exist

    def unreadable(err):
        nonlocal listed
        if err.errno == errno.ENOENT:
            return  # absent, not failed
        if err.filename == root:
            raise err
        warn(str(err))
        listed = False

    for dirpath, _dirs, names in os.walk(root, onerror=unreadable):
        for name in names:
            if not name.endswith('.jsonl'):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.stat(path)
                if st.st_mtime < cutoff:
                    continue  # every line is older than the window
                prev = old.get(path)
                if prev is not None and prev['inode'] == st.st_ino and prev['size'] == st.st_size:
                    new[path] = prev  # unchanged
                else:
                    new[path] = scan(path, prev, since)
            except FileNotFoundError:
                pass  # deleted since the listing
            except OSError as e:
                warn(str(e))  # an error is not an empty file: keep what we knew of it
                if path in old:
                    new[path] = old[path]
    if not listed:
        for path, ent in old.items():
            new.setdefault(path, ent)

    by_model = {}
    for ent in new.values():
        ent['buckets'] = {h: m for h, m in ent['buckets'].items() if h >= since}
        for models in ent['buckets'].values():
            for model, tokens in models.items():
                by_model[model] = by_model.get(model, 0) + tokens
    out = {'updated': int(now), 'since': since, 'by_model': by_model}
    write_json(state_path, {'version': VERSION, 'since': since, 'files': new})
    write_json(os.path.join(base, 'statusline-weekly.json'), out)
    return out

def main(argv=None):
    ap = argparse.ArgumentParser(description='Token usage per model over the last 7 days.')
    ap.add_argument('--max-age', type=float, default=120, metavar='SECONDS',
                    help='print the cache without scanning when it is younger than this (default 120)')
    ap.add_argument('--now', type=float, metavar='EPOCH', help='clock override, for tests')
    args = ap.parse_args(argv)
    now = time.time() if args.now is None else args.now
    config = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(os.path.expanduser('~'), '.claude')
    base = os.path.join(config, 'simple')
    cache_path = os.path.join(base, 'statusline-weekly.json')
    try:
        cache, age = read_cache(cache_path, now)
        if cache is not None and 0 <= age < args.max_age:
            return emit(cache)
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, 'statusline-weekly.lock'), 'a') as lock:
            if fcntl is not None:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:  # another run is refreshing: hand back what it wrote last
                    cache, _ = read_cache(cache_path, now)
                    return BUSY if cache is None else emit(cache)
                except OSError:
                    pass  # this filesystem has no flock: run unlocked
            cache, age = read_cache(cache_path, now)  # the previous holder may just have refreshed it
            if cache is not None and 0 <= age < args.max_age:
                return emit(cache)
            return emit(refresh(config, now))
    except OSError as e:
        warn(str(e))
        return 1

if __name__ == '__main__':
    sys.exit(main())
