"""Tests for `scripts/install.sh --remove-legacy-statusline`, stdlib unittest only.

    python3 -m unittest discover -s plugins/simple/tests -p 'test_*.py'

Versions up to 0.2.0 put two scripts and a `statusLine` setting in the user's ~/.claude; the step removes what
they wrote and nothing else. Each test builds that setup in a temporary HOME and runs the script there with a
bare environment (what `env -i` leaves, plus PATH and that HOME), so the real ~/.claude is never read or written.
The scripts are the bytes older versions shipped, taken from this repository's history by commit; a test that
needs them is skipped, saying why, where the history is not there (a shallow clone, a copy of the folder).
"""
import functools
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'scripts', 'install.sh')

# What older versions copied into ~/.claude, by the commit that shipped it and the sha256 the script knows it by.
STATUSLINE = (('85d0fb1', '0e04d20e482caa7ecae47942d72c137b057f5a1366817f101917c121dcf7553b'),
              ('249f143', 'f63273ec4d3c40af5e98fe17d443c2fbd1a935f91f5ed34341a0e1eabc1969e5'))
WEEKLY = (('85d0fb1', '80d3b12c83c0b49a76257d1d355ea80efd6fa120a9998cf1bc2340c2a39e188d'),)
# What the weekly refresh and the old renderer leave beside the scripts.
RUNTIME = ('statusline-weekly.json', 'statusline-weekly-state.json', 'statusline-weekly-state.json.tmp',
           'statusline-weekly.json.tmp', '.statusline-weekly.lock')


@functools.lru_cache(maxsize=None)
def shipped(name, commit, sha256):
    """The bytes `name` had at `commit`; skips the test that asks when this clone does not have them."""
    try:
        r = subprocess.run(['git', '-C', HERE, 'show', '%s:plugins/simple/scripts/%s' % (commit, name)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise unittest.SkipTest('git is not available, so the scripts older versions shipped cannot be read: %s' % e)
    if r.returncode != 0:
        said = r.stderr.decode('utf-8', 'replace').strip().splitlines()
        raise unittest.SkipTest('this checkout has no history for %s:%s (a shallow clone, or not a clone): %s'
                                % (commit, name, said[0] if said else 'git failed'))
    if hashlib.sha256(r.stdout).hexdigest() != sha256:
        raise AssertionError('%s:%s is not the file install.sh knows by sha256 %s' % (commit, name, sha256))
    return r.stdout


def report(stdout):
    """The legacy block of the output as {item: what was said of it}: {'statusline.py': 'removed'}."""
    items = {}
    for line in stdout.splitlines():
        m = re.match(r'^    (settings\.json statusLine|[\w.-]+): (.*)$', line)
        if m:
            items[m.group(1)] = m.group(2)
    return items


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='legacy-test-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.fresh()

    def fresh(self):
        """An empty HOME, a new one each time, so that a test can set the same scene twice."""
        self.home = tempfile.mkdtemp(prefix='home-', dir=self.tmp)
        self.claude = os.path.join(self.home, '.claude')
        # What versions up to 0.2.0 pointed `statusLine` at.
        self.legacy_command = 'python3 ' + os.path.join(self.claude, 'statusline.py')

    def path(self, name):
        return os.path.join(self.claude, name)

    def write(self, name, data):
        os.makedirs(os.path.dirname(self.path(name)), exist_ok=True)
        with open(self.path(name), 'wb') as f:
            f.write(data if isinstance(data, bytes) else data.encode('utf-8'))

    def read(self, name):
        with open(self.path(name), 'rb') as f:
            return f.read()

    def exists(self, name):
        return os.path.lexists(self.path(name))

    def settings(self, **extra):
        """The `statusLine` older versions wrote, beside what else the person had in settings.json."""
        return dict(extra, statusLine={'type': 'command', 'command': self.legacy_command, 'padding': 0})

    def write_settings(self, settings):
        self.write('settings.json', json.dumps(settings, indent=2) + '\n')

    def legacy_setup(self, statusline, weekly=None, **extra):
        """The whole old setup: the settings, both scripts as shipped, and the files the weekly refresh left."""
        self.write_settings(self.settings(**extra))
        self.write('statusline.py', statusline)
        if weekly is None:
            weekly = shipped('statusline-weekly.py', *WEEKLY[0])
        self.write('statusline-weekly.py', weekly)
        for name in RUNTIME:
            self.write(name, 'left by the weekly refresh')

    def snapshot(self):
        """Every file under HOME with its bytes (a link by its target), to tell that nothing changed."""
        seen = {}
        for root, dirs, files in os.walk(self.home):
            for name in dirs + files:
                p = os.path.join(root, name)
                rel = os.path.relpath(p, self.home)
                if os.path.islink(p):
                    seen[rel] = ('link', os.readlink(p))
                elif os.path.isdir(p):
                    seen[rel] = ('dir', None)
                else:
                    with open(p, 'rb') as f:
                        seen[rel] = ('file', f.read())
        return seen

    def run_install(self, *args):
        """install.sh --remove-legacy-statusline in a bare environment whose HOME is the temporary one."""
        env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'HOME': self.home,
               'PYTHONIOENCODING': 'utf-8'}
        r = subprocess.run(['bash', SCRIPT, '--remove-legacy-statusline'] + list(args), cwd=self.tmp, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        out = r.stdout.decode('utf-8')
        self.assertEqual(r.returncode, 0, r.stderr.decode('utf-8', 'replace'))
        # It looked where the test put the setup, not at the person's own ~/.claude.
        self.assertIn('in %s:' % self.claude, out)
        return out


class RemovesWhatOlderVersionsWroteTests(Base):
    def test_the_exact_setup_goes_with_the_scripts_as_shipped_and_what_the_weekly_refresh_left(self):
        for commit, sha256 in STATUSLINE:
            with self.subTest(statusline_py_from=commit):
                self.fresh()
                self.legacy_setup(shipped('statusline.py', commit, sha256), model='opus', env={'A': '1'})
                self.write('CLAUDE.md', "the person's own\n")
                self.write('projects/p1/s.jsonl', '{}\n')

                out = self.run_install()

                self.assertEqual(report(out), dict(
                    [('settings.json statusLine', 'removed'), ('statusline.py', 'removed'),
                     ('statusline-weekly.py', 'removed')] + [(name, 'removed') for name in RUNTIME]))
                # The setting goes; the rest of settings.json stays as it was.
                self.assertEqual(json.loads(self.read('settings.json')), {'model': 'opus', 'env': {'A': '1'}})
                for name in ('statusline.py', 'statusline-weekly.py') + RUNTIME:
                    self.assertFalse(self.exists(name), name)
                # Nothing else of the person's is touched.
                self.assertEqual(self.read('CLAUDE.md'), b"the person's own\n")
                self.assertEqual(self.read('projects/p1/s.jsonl'), b'{}\n')

    def test_a_setting_with_no_padding_key_is_the_one_older_versions_wrote_too(self):
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]))
        self.write_settings({'statusLine': {'type': 'command', 'command': self.legacy_command}})
        self.assertEqual(report(self.run_install())['settings.json statusLine'], 'removed')
        self.assertEqual(json.loads(self.read('settings.json')), {})

    def test_the_scripts_go_without_a_status_line_setting_to_point_at_them(self):
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]))
        self.write_settings({'model': 'opus'})
        out = report(self.run_install())
        self.assertEqual(out['settings.json statusLine'], 'absent')
        self.assertEqual((out['statusline.py'], out['statusline-weekly.py']), ('removed', 'removed'))
        self.assertEqual(json.loads(self.read('settings.json')), {'model': 'opus'})


class KeepsWhatIsNotTheirsTests(Base):
    def test_a_script_that_was_modified_is_kept(self):
        original = shipped('statusline.py', *STATUSLINE[1])
        self.legacy_setup(original + b'# mine\n')
        out = report(self.run_install())
        self.assertEqual(out['statusline.py'], 'kept — it differs from what the plugin shipped')
        self.assertEqual(self.read('statusline.py'), original + b'# mine\n')
        # The other script, as shipped, and the setting still go.
        self.assertEqual((out['statusline-weekly.py'], out['settings.json statusLine']), ('removed', 'removed'))
        self.assertFalse(self.exists('statusline-weekly.py'))

    def test_a_modified_weekly_script_is_kept_and_so_is_what_it_left(self):
        original = shipped('statusline-weekly.py', *WEEKLY[0])
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]), weekly=original.replace(b'\n', b'\n\n', 1))
        out = report(self.run_install())
        self.assertEqual(out['statusline-weekly.py'], 'kept — it differs from what the plugin shipped')
        self.assertTrue(self.exists('statusline-weekly.py'))
        for name in RUNTIME:
            self.assertEqual(out[name], 'kept — statusline-weekly.py is still here')
            self.assertEqual(self.read(name), b'left by the weekly refresh')
        self.assertEqual(out['statusline.py'], 'removed')

    def test_a_script_that_is_a_link_or_not_a_file_is_kept(self):
        original = shipped('statusline.py', *STATUSLINE[0])
        self.legacy_setup(original)
        os.remove(self.path('statusline.py'))
        self.write('elsewhere.py', original)
        os.symlink(self.path('elsewhere.py'), self.path('statusline.py'))
        os.remove(self.path('statusline-weekly.py'))
        os.mkdir(self.path('statusline-weekly.py'))
        out = report(self.run_install())
        self.assertEqual((out['statusline.py'], out['statusline-weekly.py']),
                         ('kept — not a regular file', 'kept — not a regular file'))
        self.assertTrue(os.path.islink(self.path('statusline.py')))
        self.assertTrue(os.path.isdir(self.path('statusline-weekly.py')))
        self.assertEqual(self.read('elsewhere.py'), original)

    def test_a_custom_status_line_stays_byte_for_byte(self):
        # Odd spacing, no final newline: the file is not even rewritten.
        raw = b'{"statusLine":   {"type": "command", "command": "bash ~/.claude/my-line.sh"},\n\t"model": "opus"}'
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]))
        self.write('settings.json', raw)
        out = report(self.run_install())
        self.assertEqual(out['settings.json statusLine'], 'kept — it is not the one older versions installed')
        self.assertEqual(self.read('settings.json'), raw)
        # It does not name statusline.py, so the scripts nothing points at any more go.
        self.assertEqual((out['statusline.py'], out['statusline-weekly.py']), ('removed', 'removed'))

    def test_a_custom_status_line_that_still_names_the_script_keeps_the_scripts_too(self):
        raw = ('{"statusLine": {"type": "command", "command": "python3 %s --theme dark"}}'
               % self.path('statusline.py')).encode('utf-8')
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]))
        self.write('settings.json', raw)
        out = report(self.run_install())
        self.assertEqual(self.read('settings.json'), raw)
        hold = 'kept — your statusLine still mentions statusline.py'
        self.assertEqual((out['statusline.py'], out['statusline-weekly.py']), (hold, hold))
        for name in RUNTIME:
            self.assertEqual(out[name], 'kept — statusline-weekly.py is still here')
        self.assertTrue(self.exists('statusline.py') and self.exists('statusline-weekly.py'))

    def test_a_status_line_that_only_looks_like_the_old_one_is_kept(self):
        # Each differs from the old one in one thing; the command is the old one's wherever it is not the thing.
        near = {
            'a command of another path': lambda command: {'type': 'command', 'padding': 0,
                                                          'command': 'python3 /opt/tools/statusline.py'},
            'a padding': lambda command: {'type': 'command', 'command': command, 'padding': 2},
            'a key of its own': lambda command: {'type': 'command', 'command': command, 'refreshInterval': 5},
            'another type': lambda command: {'type': 'static', 'command': command},
            'a command that is not text': lambda command: {'type': 'command', 'command': ['python3', command]},
            'a plain string': lambda command: command,
        }
        for name, status_line in near.items():
            with self.subTest(name):
                self.fresh()
                self.write_settings({'statusLine': status_line(self.legacy_command)})
                before = self.read('settings.json')
                out = report(self.run_install())
                self.assertEqual(out['settings.json statusLine'],
                                 'kept — it is not the one older versions installed')
                self.assertEqual(self.read('settings.json'), before)


class DryRunTests(Base):
    def test_changes_nothing_and_says_what_it_would_do(self):
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]), model='opus')
        before = self.snapshot()

        out = self.run_install('--dry-run')

        self.assertEqual(self.snapshot(), before)
        self.assertIn('(dry run — nothing will be written)', out)
        self.assertEqual(report(out), dict(
            [('settings.json statusLine', 'would remove'), ('statusline.py', 'would remove'),
             ('statusline-weekly.py', 'would remove')] + [(name, 'would remove') for name in RUNTIME]))

    def test_a_real_run_after_it_does_what_it_said(self):
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]), model='opus')
        self.run_install('--dry-run')
        out = report(self.run_install())
        self.assertEqual(set(out.values()), {'removed'})
        self.assertEqual(json.loads(self.read('settings.json')), {'model': 'opus'})
        self.assertFalse(self.exists('statusline.py'))


class SettingsThatCannotBeReadTests(Base):
    def test_invalid_json_is_skipped_and_nothing_is_changed(self):
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]))
        self.write('settings.json', b'{ "statusLine": ')
        before = self.snapshot()

        out = self.run_install()

        self.assertIn('settings.json could not be read as JSON', out)
        self.assertIn('nothing was changed', out)
        self.assertEqual(report(out), {})
        # It stops, settings and scripts alike; it does not carry on as if the settings held nothing.
        self.assertEqual(self.snapshot(), before)

    def test_a_settings_file_that_is_not_an_object_is_skipped_too(self):
        for text in ('[]', '"statusline.py"', 'null', ''):
            with self.subTest(text):
                self.fresh()
                self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]))
                self.write('settings.json', text)
                before = self.snapshot()
                out = self.run_install()
                self.assertIn('could not be read as JSON', out)
                self.assertEqual(self.snapshot(), before)


class SecondRunTests(Base):
    def test_reports_everything_absent_and_changes_nothing(self):
        self.legacy_setup(shipped('statusline.py', *STATUSLINE[0]), model='opus')
        self.run_install()
        after_first = self.snapshot()

        out = report(self.run_install())

        self.assertEqual(out, dict([('settings.json statusLine', 'absent'), ('statusline.py', 'absent'),
                                    ('statusline-weekly.py', 'absent')] + [(name, 'absent') for name in RUNTIME]))
        self.assertEqual(self.snapshot(), after_first)

    def test_a_home_with_no_claude_folder_is_all_absent_and_stays_so(self):
        out = report(self.run_install())
        self.assertEqual(set(out.values()), {'absent'})
        self.assertEqual(len(out), 3 + len(RUNTIME))
        self.assertEqual(os.listdir(self.home), [])


if __name__ == '__main__':
    unittest.main()
