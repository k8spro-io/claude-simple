"""Tests for scripts/statusline-weekly.py, stdlib unittest only.

    python3 -m unittest discover -s plugins/simple/tests -p 'test_*.py'

Each test runs the script the way the status line does (python3 -I, a fake HOME and CLAUDE_CONFIG_DIR, a
fixed --now) on transcripts it writes into a temp dir, so nothing outside that dir is read or written. The
five that patch fcntl or os load it as a module instead and call main() in the same environment.
"""
import ast
import calendar
import contextlib
import errno
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

try:
    import fcntl
except ImportError:
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'scripts', 'statusline-weekly.py')
NOW = calendar.timegm((2026, 10, 7, 14, 30, 0))
SINCE = '2026-09-30T14'  # the UTC hour of NOW - 7 days: the window starts there
DAY = 86400
RECENT = '2026-10-07T13:05:00.000Z'
IS_ROOT = hasattr(os, 'geteuid') and os.geteuid() == 0


def use(inp=1, out=10, cc=100, cr=1000):
    return {'input_tokens': inp, 'output_tokens': out, 'cache_creation_input_tokens': cc,
            'cache_read_input_tokens': cr}


def only_input(n):
    return use(inp=n, out=0, cc=0, cr=0)


def rec(ts=RECENT, mid='m1', rid='r1', model='model-a', usage=None):
    """One assistant transcript line; 1111 tokens unless `usage` says otherwise."""
    msg = {'role': 'assistant', 'usage': use() if usage is None else usage}
    if mid is not None:
        msg['id'] = mid
    if model is not None:
        msg['model'] = model
    r = {'type': 'assistant', 'timestamp': ts, 'message': msg}
    if rid is not None:
        r['requestId'] = rid
    return r


def blob(*recs):
    return b''.join(json.dumps(r).encode() + b'\n' for r in recs)


def load_script(block_fcntl=False):
    """The script as a module, optionally as on a platform without fcntl."""
    spec = importlib.util.spec_from_file_location('statusline_weekly_under_test', SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {'fcntl': None} if block_fcntl else {}), \
            mock.patch.object(sys, 'dont_write_bytecode', True):
        spec.loader.exec_module(mod)
    return mod


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='weekly-test-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.home = os.path.join(self.tmp, 'home')
        self.cfg = os.path.join(self.tmp, 'cfg')
        os.makedirs(self.home)

    simple = property(lambda self: os.path.join(self.cfg, 'simple'))
    cache_path = property(lambda self: os.path.join(self.simple, 'statusline-weekly.json'))
    state_path = property(lambda self: os.path.join(self.simple, 'statusline-weekly-state.json'))
    lock_path = property(lambda self: os.path.join(self.simple, 'statusline-weekly.lock'))

    def path(self, rel):
        return os.path.join(self.cfg, 'projects', *rel.split('/'))

    def write(self, rel, data, mtime=NOW - 60):
        p = self.path(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data)
        os.utime(p, (mtime, mtime))
        return p

    def append(self, rel, data, mtime=NOW - 60):
        p = self.path(rel)
        with open(p, 'ab') as f:
            f.write(data)
        os.utime(p, (mtime, mtime))

    def env(self, extra=None):
        # USERPROFILE too: expanduser reads it, not HOME, on Windows
        env = dict(os.environ, HOME=self.home, USERPROFILE=self.home, CLAUDE_CONFIG_DIR=self.cfg)
        env.update(extra or {})
        return env

    def run_script(self, *args, now=NOW, max_age=0, env=None):
        argv = [sys.executable, '-I', SCRIPT, '--max-age', str(max_age), '--now', str(now)] + list(args)
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                              env=self.env(env), timeout=120)

    def totals(self, **kw):
        """by_model of a successful run."""
        r = self.run_script(**kw)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)['by_model']

    def state(self):
        with open(self.state_path) as f:
            return json.load(f)

    def entry(self, rel):
        return self.state()['files'][self.path(rel)]

    def call(self, mod, now=NOW, max_age=0):
        """mod.main() in this process with the fake environment: (exit code, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.env()), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            code = mod.main(['--max-age', str(max_age), '--now', str(now)])
        return code, out.getvalue(), err.getvalue()


class ContractTests(Base):
    def test_prints_one_json_object_and_caches_the_same_one(self):
        self.write('p1/s.jsonl', blob(rec(mid='a'), rec(mid='b', model='model-b', usage=use(out=5))))
        r = self.run_script(now='%d.75' % NOW)
        self.assertEqual((r.returncode, r.stderr), (0, ''))
        out = json.loads(r.stdout)  # exactly one object on stdout
        self.assertEqual(out, {'updated': NOW, 'since': SINCE,
                               'by_model': {'model-a': 1111, 'model-b': 1106}})
        with open(self.cache_path) as f:
            self.assertEqual(json.load(f), out)
        self.assertTrue(os.path.exists(self.state_path) and os.path.exists(self.lock_path))

    def test_no_transcripts_is_an_empty_result_not_an_error(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {'updated': NOW, 'since': SINCE, 'by_model': {}})

    def test_config_dir_defaults_to_dot_claude_in_home(self):
        self.cfg = os.path.join(self.home, '.claude')
        self.write('p1/s.jsonl', blob(rec()))
        # an empty variable counts as unset
        self.assertEqual(self.totals(env={'CLAUDE_CONFIG_DIR': ''}), {'model-a': 1111})
        self.assertTrue(os.path.exists(self.cache_path))

    def test_the_legacy_files_are_never_touched(self):
        self.cfg = os.path.join(self.home, '.claude')  # the same directory the legacy script used
        self.write('p1/s.jsonl', blob(rec()))
        names = ('statusline-weekly.json', 'statusline-weekly-state.json', '.statusline-weekly.lock')
        legacy = {name: os.path.join(self.cfg, name) for name in names}
        for p in legacy.values():
            with open(p, 'w') as f:
                f.write('legacy')
            os.utime(p, (NOW - 1000, NOW - 1000))
        self.assertEqual(self.totals(env={'CLAUDE_CONFIG_DIR': ''}), {'model-a': 1111})
        for p in legacy.values():
            with open(p) as f:
                self.assertEqual(f.read(), 'legacy')
            self.assertEqual(os.stat(p).st_mtime, NOW - 1000)

    def test_a_young_cache_is_printed_without_scanning(self):
        self.write('p1/s.jsonl', blob(rec(mid='a')))
        first = self.totals()
        self.append('p1/s.jsonl', blob(rec(mid='b')))
        os.utime(self.cache_path, (NOW - 30, NOW - 30))
        os.remove(self.lock_path)
        self.assertEqual(self.totals(max_age=120), first)  # the new line is not looked at
        self.assertFalse(os.path.exists(self.lock_path))  # and the lock is not even touched
        os.utime(self.cache_path, (NOW - 300, NOW - 300))
        self.assertEqual(self.totals(max_age=120), {'model-a': 2222})  # older than max-age: scanned

    def test_a_young_cache_is_printed_as_the_three_known_keys(self):
        os.makedirs(self.simple)
        with open(self.cache_path, 'w') as f:
            json.dump({'updated': NOW - 5, 'since': SINCE, 'by_model': {'model-a': 3}, 'extra': 1}, f)
        os.utime(self.cache_path, (NOW - 5, NOW - 5))
        r = self.run_script(max_age=120)
        self.assertEqual(json.loads(r.stdout),
                         {'updated': NOW - 5, 'since': SINCE, 'by_model': {'model-a': 3}})

    def test_a_cache_from_the_future_is_not_trusted(self):
        self.write('p1/s.jsonl', blob(rec(mid='a')))
        self.totals()
        self.append('p1/s.jsonl', blob(rec(mid='b')))
        os.utime(self.cache_path, (NOW + 3600, NOW + 3600))
        self.assertEqual(self.totals(max_age=120), {'model-a': 2222})

    def test_an_unusable_cache_is_ignored(self):
        self.write('p1/s.jsonl', blob(rec()))
        os.makedirs(self.simple)
        for junk in ('not json', '[]', '{"updated": "x", "since": "s", "by_model": {}}',
                     '{"updated": 1, "since": 5, "by_model": {}}',
                     '{"updated": 1, "since": "s", "by_model": []}',
                     '{"updated": 1, "since": "s", "by_model": {"m": "many"}}'):
            with self.subTest(junk=junk):
                with open(self.cache_path, 'w') as f:
                    f.write(junk)
                os.utime(self.cache_path, (NOW - 1, NOW - 1))
                self.assertEqual(self.totals(max_age=120), {'model-a': 1111})

    @unittest.skipUnless(fcntl, 'needs fcntl')
    def test_a_busy_lock_hands_back_the_existing_cache(self):
        self.write('p1/s.jsonl', blob(rec(mid='a')))
        first = self.run_script().stdout
        self.append('p1/s.jsonl', blob(rec(mid='b')))
        with open(self.lock_path, 'a') as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = self.run_script()
            self.assertEqual((r.returncode, r.stdout), (0, first))  # nothing rescanned
        self.assertEqual(self.totals(), {'model-a': 2222})  # lock released: scans again

    @unittest.skipUnless(fcntl, 'needs fcntl')
    def test_a_busy_lock_without_a_cache_exits_75_and_prints_nothing(self):
        self.write('p1/s.jsonl', blob(rec()))
        os.makedirs(self.simple)
        with open(self.lock_path, 'a') as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = self.run_script()
        self.assertEqual((r.returncode, r.stdout), (75, ''))
        self.assertFalse(os.path.exists(self.cache_path) or os.path.exists(self.state_path))

    @unittest.skipUnless(fcntl, 'needs fcntl')
    def test_the_lock_is_free_again_when_the_run_ends(self):
        self.totals()
        with open(self.lock_path, 'a') as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)

    @unittest.skipUnless(fcntl, 'needs fcntl to hold the lock')
    def test_without_fcntl_it_runs_unlocked(self):
        self.write('p1/s.jsonl', blob(rec()))
        os.makedirs(self.simple)
        mod = load_script(block_fcntl=True)
        self.assertIsNone(mod.fcntl)
        with open(self.lock_path, 'a') as other:
            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, out, _ = self.call(mod)
        self.assertEqual((code, json.loads(out)['by_model']), (0, {'model-a': 1111}))

    @unittest.skipUnless(fcntl, 'needs fcntl')
    def test_a_filesystem_without_flock_runs_unlocked(self):
        self.write('p1/s.jsonl', blob(rec()))
        mod = load_script()
        no_locks = OSError(errno.ENOLCK, 'no locks available')
        with mock.patch.object(mod.fcntl, 'flock', side_effect=no_locks):
            code, out, _ = self.call(mod)
        self.assertEqual((code, json.loads(out)['by_model']), (0, {'model-a': 1111}))

    @unittest.skipUnless(fcntl, 'needs fcntl')
    def test_a_cache_refreshed_while_waiting_for_the_lock_is_used(self):
        self.write('p1/s.jsonl', blob(rec(mid='a')))
        fresh = {'updated': NOW, 'since': SINCE, 'by_model': {'model-z': 5}}
        mod = load_script()

        def previous_holder_finishes(*args):
            with open(self.cache_path, 'w') as f:
                json.dump(fresh, f)
            os.utime(self.cache_path, (NOW - 1, NOW - 1))

        with mock.patch.object(mod.fcntl, 'flock', side_effect=previous_holder_finishes):
            code, out, _ = self.call(mod, max_age=120)
        self.assertEqual((code, json.loads(out)), (0, fresh))
        self.assertFalse(os.path.exists(self.state_path))  # no scan

    def test_an_unusable_output_dir_is_exit_1_with_a_message(self):
        self.write('p1/s.jsonl', blob(rec()))
        with open(self.simple, 'w') as f:  # a file where the directory should be
            f.write('x')
        r = self.run_script()
        self.assertEqual((r.returncode, r.stdout), (1, ''))
        self.assertIn('statusline-weekly:', r.stderr)
        self.assertNotIn('Traceback', r.stderr)

    def test_python_3_8_syntax(self):
        for path in (SCRIPT, __file__):
            with self.subTest(path=os.path.basename(path)), open(path) as f:
                ast.parse(f.read(), feature_version=(3, 8))


class CountingTests(Base):
    def test_the_blocks_of_one_response_count_once_with_the_last_usage(self):
        blocks = [rec(mid='m', rid='r', usage=use(inp=2, out=o)) for o in (1, 50, 219)]
        self.write('p1/s.jsonl', blob(*blocks, rec(mid='n', rid='q', usage=use(out=7))))
        self.assertEqual(self.totals(), {'model-a': (2 + 219 + 1100) + (1 + 7 + 1100)})

    def test_a_response_split_across_two_runs_counts_once(self):
        self.write('p1/s.jsonl', blob(rec(mid='m', usage=use(inp=2, out=1)),
                                      rec(mid='m', usage=use(inp=2, out=5))))
        self.assertEqual(self.totals(), {'model-a': 2 + 5 + 1100})
        self.append('p1/s.jsonl', blob(rec(mid='m', usage=use(inp=2, out=50)), rec(mid='n')))
        self.assertEqual(self.totals(), {'model-a': (2 + 50 + 1100) + 1111})

    def test_lines_without_usage_between_blocks_do_not_split_a_response(self):
        plain = {'type': 'user', 'timestamp': RECENT, 'message': {'role': 'user', 'content': 'hi'}}
        self.write('p1/s.jsonl', blob(rec(usage=use(out=1)), plain, rec(usage=use(out=20))))
        self.assertEqual(self.totals(), {'model-a': 1 + 20 + 1100})

    def test_a_later_block_never_lowers_the_response(self):
        self.write('p1/s.jsonl', blob(rec(usage=use(out=50)), rec(usage=use(out=5))))
        self.assertEqual(self.totals(), {'model-a': 1 + 50 + 1100})

    def test_the_same_message_id_with_another_request_id_is_a_separate_response(self):
        self.write('p1/s.jsonl', blob(rec(rid='r1'), rec(rid='r2')))
        self.assertEqual(self.totals(), {'model-a': 2222})

    def test_lines_without_a_message_id_are_all_counted(self):
        self.write('p1/s.jsonl', blob(rec(mid=None), rec(mid=None), rec(mid='', rid=None)))
        self.assertEqual(self.totals(), {'model-a': 3333})

    def test_null_and_non_integer_counts_are_zero(self):
        usages = [
            {'input_tokens': None, 'output_tokens': 10, 'cache_creation_input_tokens': 100,
             'cache_read_input_tokens': 1000},
            {'input_tokens': '5', 'output_tokens': 1.5, 'cache_creation_input_tokens': True,
             'cache_read_input_tokens': [3]},
            {'input_tokens': -4, 'output_tokens': 10},
            {},
        ]
        self.write('p1/s.jsonl', blob(*[rec(mid=str(i), usage=u) for i, u in enumerate(usages)]))
        self.assertEqual(self.totals(), {'model-a': 1110 + 0 + 10 + 0})

    def test_lines_that_are_not_usage_records_are_ignored(self):
        ts = RECENT
        junk = [
            b'not json "usage"', b'[]', b'"usage"', b'42', b'null', b'', b'\xff\xfe broken "usage"',
            b'[' * 200000 + b'"usage"' + b']' * 200000,
            json.dumps({'timestamp': ts, 'message': 'text "usage"'}).encode(),
            json.dumps({'timestamp': ts, 'message': {'usage': None}}).encode(),
            json.dumps({'timestamp': ts, 'message': {'usage': [1]}}).encode(),
            json.dumps({'message': {'id': 'x', 'usage': use()}}).encode(),
            json.dumps({'timestamp': 1791383400, 'message': {'id': 'y', 'usage': use()}}).encode(),
            json.dumps(rec(ts='yesterday')).encode(),
            json.dumps(rec(ts='2026-10-07 13:05:00')).encode(),
        ]
        self.write('p1/s.jsonl', b'\n'.join(junk) + b'\n' + blob(rec(mid='ok')))
        self.assertEqual(self.totals(), {'model-a': 1111})

    def test_a_missing_or_unusable_model_is_unknown(self):
        self.write('p1/s.jsonl', blob(rec(mid='a', model=None), rec(mid='b', model=''), rec(mid='c', model=5),
                                      rec(mid='d', model={'x': 1})))
        self.assertEqual(self.totals(), {'unknown': 4444})

    def test_models_are_kept_apart_and_empty_ones_are_not_listed(self):
        empty = {'input_tokens': None, 'output_tokens': 0}
        self.write('p1/s.jsonl', blob(rec(mid='a'), rec(mid='b', model='model-b'),
                                      rec(mid='c', model='model-c', usage=empty)))
        self.assertEqual(self.totals(), {'model-a': 1111, 'model-b': 1111})

    def test_subfolders_are_scanned_and_only_jsonl_files(self):
        self.write('p1/s.jsonl', blob(rec(mid='a')))
        self.write('p1/s/subagents/agent-1.jsonl', blob(rec(mid='b')))
        self.write('p2/deeper/still/t.jsonl', blob(rec(mid='c')))
        for other in ('p1/notes.json', 'p1/s.jsonl.bak', 'p1/t.txt', 'p1/jsonl'):
            self.write(other, blob(rec(mid='x')))
        self.assertEqual(self.totals(), {'model-a': 3333})


class WindowTests(Base):
    def test_the_window_is_utc_hours_whatever_the_local_zone(self):
        lines = [rec(ts='2026-09-29T23:59:59.000Z', mid='day-before', usage=only_input(7)),
                 rec(ts='2026-09-30T13:59:59.999Z', mid='last-ms-out', usage=only_input(70)),
                 rec(ts='2026-09-30T14:00:00.000Z', mid='first-ms-in', usage=only_input(700)),
                 rec(ts='2026-09-30T23:30:00.000Z', mid='later-that-day', usage=only_input(7000))]
        self.write('p1/s.jsonl', blob(*lines))
        for tz in ('UTC0', 'XXX-14', 'XXX+11'):  # UTC, UTC+14, UTC-11
            with self.subTest(tz=tz):
                self.assertEqual(self.totals(env={'TZ': tz}), {'model-a': 700 + 7000})

    def test_the_window_slides_with_the_clock(self):
        self.write('p1/s.jsonl', blob(rec(ts='2026-09-30T14:00:00.000Z', mid='a', usage=only_input(1)),
                                      rec(ts='2026-09-30T15:00:00.000Z', mid='b', usage=only_input(10))))
        self.assertEqual(self.totals(), {'model-a': 11})
        self.assertEqual(self.totals(now=NOW + 3600), {'model-a': 10})
        self.assertEqual(self.totals(now=NOW + 7200), {})
        self.assertEqual(self.entry('p1/s.jsonl')['buckets'], {})  # expired hours leave the state too

    def test_a_response_straddling_the_window_start_counts_by_its_first_block(self):
        self.write('p1/s.jsonl', blob(rec(ts='2026-09-30T13:59:59.000Z', usage=use(out=1)),
                                      rec(ts='2026-09-30T14:00:01.000Z', usage=use(out=50))))
        self.assertEqual(self.totals(), {})

    def test_a_clock_that_went_back_rebuilds_the_hours_pruned_before(self):
        self.write('p1/s.jsonl', blob(rec(ts='2026-09-28T10:00:00.000Z', mid='old', usage=only_input(111)),
                                      rec(mid='new')))
        self.assertEqual(self.totals(), {'model-a': 1111})
        self.assertEqual(self.totals(now=NOW - 3 * DAY), {'model-a': 1111 + 111})

    def test_a_file_older_than_the_window_is_not_read(self):
        # lines inside the window in a file last written 8 days ago: cannot happen, so it is never opened
        old = self.write('p1/old.jsonl', blob(rec(mid='a')), mtime=NOW - 8 * DAY)
        self.write('p1/new.jsonl', blob(rec(mid='b', model='model-b')))
        self.assertEqual(self.totals(), {'model-b': 1111})
        self.assertNotIn(old, self.state()['files'])

    def test_the_oldest_hour_of_the_window_is_still_read(self):
        mtime = calendar.timegm((2026, 9, 30, 14, 10, 0))  # before NOW - 7 days, inside the first hour
        self.write('p1/s.jsonl', blob(rec(ts='2026-09-30T14:10:00.000Z')), mtime=mtime)
        self.assertEqual(self.totals(), {'model-a': 1111})

    def test_deleted_and_aged_out_files_leave_the_state_and_the_totals(self):
        keep = self.write('p1/keep.jsonl', blob(rec(mid='a')))
        gone = self.write('p1/gone.jsonl', blob(rec(mid='b')))
        aged = self.write('p1/aged.jsonl', blob(rec(mid='c')), mtime=NOW - 6 * DAY)
        self.assertEqual(self.totals(), {'model-a': 3333})
        self.assertEqual(sorted(self.state()['files']), sorted([keep, gone, aged]))
        os.remove(gone)
        self.assertEqual(self.totals(now=NOW + 2 * DAY), {'model-a': 1111})
        self.assertEqual(list(self.state()['files']), [keep])


class FileTrackingTests(Base):
    def test_an_unchanged_prefix_is_not_parsed_again(self):
        p = self.write('p1/s.jsonl', blob(rec(mid='a'), rec(mid='b')))
        self.assertEqual(self.totals(), {'model-a': 2222})
        with open(p, 'r+b') as f:  # change the consumed part, keeping its length
            data = f.read().replace(b'"input_tokens": 1,', b'"input_tokens": 9,')
            f.seek(0)
            f.write(data)
        self.append('p1/s.jsonl', blob(rec(mid='c')))
        self.assertEqual(self.totals(), {'model-a': 3333})

    def test_a_replaced_file_is_read_again_from_the_start(self):
        p = self.write('p1/s.jsonl', blob(rec(mid='a'), rec(mid='b')))
        self.assertEqual(self.totals(), {'model-a': 2222})
        before = os.stat(p).st_ino
        outs = (7, 70, 700, 7000)  # longer than before and with lines of different lengths
        with open(p + '.new', 'wb') as f:
            f.write(blob(*[rec(mid=m, usage=use(out=o)) for m, o in zip('cdef', outs)]))
        os.utime(p + '.new', (NOW - 60, NOW - 60))
        os.replace(p + '.new', p)
        self.assertNotEqual(os.stat(p).st_ino, before)
        self.assertEqual(self.totals(), {'model-a': sum(1 + o + 1100 for o in outs)})

    def test_a_truncated_file_is_read_again_from_the_start(self):
        self.write('p1/s.jsonl', blob(rec(mid='a'), rec(mid='b'), rec(mid='c')))
        self.assertEqual(self.totals(), {'model-a': 3333})
        self.write('p1/s.jsonl', blob(rec(mid='d')))  # same inode, shorter
        self.assertEqual(self.totals(), {'model-a': 1111})

    def test_an_incomplete_last_line_waits_until_it_is_complete(self):
        first, second = blob(rec(mid='a')), json.dumps(rec(mid='b')).encode()
        self.write('p1/s.jsonl', first + second[:40])  # the writer stopped mid-line
        self.assertEqual(self.totals(), {'model-a': 1111})
        entry = self.entry('p1/s.jsonl')
        self.assertEqual((entry['offset'], entry['size']), (len(first), len(first) + 40))
        self.append('p1/s.jsonl', second[40:] + b'\n')
        self.assertEqual(self.totals(), {'model-a': 2222})
        self.assertEqual(self.totals(), {'model-a': 2222})  # and only once

    def test_a_file_deleted_after_the_listing_is_skipped_quietly(self):
        self.write('p1/a.jsonl', blob(rec(mid='a')))
        gone = self.write('p1/gone.jsonl', blob(rec(mid='b')))
        mod = load_script()
        real_stat = os.stat

        def stat(path, *args, **kw):
            if path == gone:
                raise FileNotFoundError(errno.ENOENT, 'gone', path)
            return real_stat(path, *args, **kw)

        with mock.patch.object(mod.os, 'stat', side_effect=stat):
            code, out, err = self.call(mod)
        self.assertEqual((code, json.loads(out)['by_model'], err), (0, {'model-a': 1111}, ''))

    def test_an_unreadable_file_keeps_its_last_known_contribution(self):
        if IS_ROOT:
            self.skipTest('root ignores file modes')
        self.write('p1/a.jsonl', blob(rec(mid='a')))
        b = self.write('p1/b.jsonl', blob(rec(mid='b')))
        self.assertEqual(self.totals(), {'model-a': 2222})
        self.append('p1/a.jsonl', blob(rec(mid='c')))
        self.append('p1/b.jsonl', blob(rec(mid='d')))
        os.chmod(b, 0)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        # a is read in full, b stays as last known
        self.assertEqual(json.loads(r.stdout)['by_model'], {'model-a': 3333})
        self.assertIn(b, r.stderr)

    def test_an_unlistable_directory_does_not_prune_what_it_holds(self):
        if IS_ROOT:
            self.skipTest('root ignores directory modes')
        self.write('p1/a.jsonl', blob(rec(mid='a')))
        self.write('p2/b.jsonl', blob(rec(mid='b')))
        self.assertEqual(self.totals(), {'model-a': 2222})
        hidden = os.path.dirname(self.path('p2/b.jsonl'))
        os.chmod(hidden, 0)
        self.addCleanup(os.chmod, hidden, 0o755)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['by_model'], {'model-a': 2222})
        self.assertIn('p2', r.stderr)

    def test_an_unreadable_projects_dir_stops_the_run(self):
        if IS_ROOT:
            self.skipTest('root ignores directory modes')
        self.write('p1/a.jsonl', blob(rec()))
        os.chmod(os.path.join(self.cfg, 'projects'), 0)
        self.addCleanup(os.chmod, os.path.join(self.cfg, 'projects'), 0o755)
        r = self.run_script()
        self.assertEqual((r.returncode, r.stdout), (1, ''))
        self.assertFalse(os.path.exists(self.cache_path))

    @unittest.skipUnless(sys.platform.startswith('linux'), 'ru_maxrss is in kB on Linux only')
    def test_a_large_transcript_is_streamed_not_loaded(self):
        filler = {'type': 'user', 'message': {'role': 'user', 'content': 'x' * 4000}}
        filler = json.dumps(filler).encode() + b'\n'
        p = self.write('p1/big.jsonl', blob(rec(mid='a')))
        with open(p, 'ab') as f:
            for _ in range(64):
                f.write(filler * 256)  # 64 MB of lines without usage
            f.write(blob(rec(mid='b')))
        os.utime(p, (NOW - 60, NOW - 60))
        code = ('import resource, subprocess, sys\n'
                'subprocess.run(sys.argv[1:], check=True)\n'
                'print(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)')
        argv = [sys.executable, '-I', '-c', code, sys.executable, '-I', SCRIPT, '--max-age', '0',
                '--now', str(NOW)]
        r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                           env=self.env(), timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        printed, peak_kb = r.stdout.splitlines()
        self.assertEqual(json.loads(printed)['by_model'], {'model-a': 2222})
        self.assertLess(int(peak_kb), 40 * 1024)  # far below the 64 MB file


class StateTests(Base):
    def test_runs_without_new_lines_change_nothing(self):
        self.write('p1/s.jsonl', blob(rec(mid='a'), rec(mid='b')))
        first = self.totals()
        state = self.state()
        self.assertEqual((self.totals(), self.state()), (first, state))

    def test_file_names_that_are_not_valid_text_survive_the_state(self):
        names = ['caf\u00e9-\u2603.jsonl', os.fsdecode(b'\xff\xfebad.jsonl')]
        try:
            for i, name in enumerate(names):
                self.write('p1/' + name, blob(rec(mid=str(i))))
        except (OSError, UnicodeError):
            self.skipTest('this filesystem refuses such names')
        self.assertEqual(self.totals(), {'model-a': 2222})
        self.assertEqual(self.totals(), {'model-a': 2222})  # the state was written and read back

    def test_a_corrupt_state_is_rebuilt(self):
        self.write('p1/s.jsonl', blob(rec()))
        self.totals()
        with open(self.state_path, 'w') as f:
            f.write('{"version": 1, "files": {')
        self.assertEqual(self.totals(), {'model-a': 1111})

    def test_a_state_of_another_version_is_not_trusted(self):
        self.write('p1/s.jsonl', blob(rec()))
        self.totals()
        state = self.state()
        state['version'] += 1
        state['files'][self.path('p1/s.jsonl')]['buckets'][RECENT[:13]]['model-a'] += 5
        with open(self.state_path, 'w') as f:
            json.dump(state, f)
        self.assertEqual(self.totals(), {'model-a': 1111})

    def test_state_entries_that_make_no_sense_are_dropped_and_read_again(self):
        self.write('p1/a.jsonl', blob(rec(mid='a')))
        self.write('p1/b.jsonl', blob(rec(mid='b')))
        self.write('p1/c.jsonl', blob(rec(mid='c')))
        self.assertEqual(self.totals(), {'model-a': 3333})
        files = self.state()['files']
        files[self.path('p1/a.jsonl')]['offset'] = 'x'
        files[self.path('p1/b.jsonl')]['buckets'] = {RECENT[:13]: {'model-a': 'many'}}
        files[self.path('p1/c.jsonl')].update(offset=10 ** 9, size=5, buckets={})
        with open(self.state_path, 'w') as f:
            json.dump({'version': 1, 'since': SINCE, 'files': files}, f)
        self.append('p1/a.jsonl', blob(rec(mid='d')))
        self.assertEqual(self.totals(), {'model-a': 4444})


class WriteTests(Base):
    def test_temp_files_are_unique_and_none_is_left_behind(self):
        self.write('p1/s.jsonl', blob(rec()))
        os.makedirs(self.simple)
        # the names a writer with fixed temp names would use
        fixed = [self.state_path + '.tmp', self.cache_path + '.tmp']
        for p in fixed:
            with open(p, 'w') as f:
                f.write('someone else is writing')
        self.assertEqual(self.totals(), {'model-a': 1111})
        for p in fixed:
            with open(p) as f:
                self.assertEqual(f.read(), 'someone else is writing')
        self.assertEqual(sorted(os.listdir(self.simple)), sorted(
            ['statusline-weekly.json', 'statusline-weekly-state.json', 'statusline-weekly.lock'] +
            [os.path.basename(p) for p in fixed]))

    def test_a_failed_write_leaves_no_temp_file_and_the_old_cache(self):
        self.write('p1/s.jsonl', blob(rec(mid='a')))
        first = self.run_script().stdout
        self.append('p1/s.jsonl', blob(rec(mid='b')))
        mod = load_script()
        with mock.patch.object(mod.os, 'replace', side_effect=OSError(errno.EIO, 'disk trouble')):
            code, out, err = self.call(mod)
        self.assertEqual((code, out), (1, ''))
        self.assertIn('disk trouble', err)
        self.assertEqual(sorted(os.listdir(self.simple)), sorted(
            ['statusline-weekly.json', 'statusline-weekly-state.json', 'statusline-weekly.lock']))
        with open(self.cache_path) as f:
            self.assertEqual(json.load(f), json.loads(first))


if __name__ == '__main__':
    unittest.main()
