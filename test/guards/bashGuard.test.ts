import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  analyzeTowerBashCommand,
  commandNeedsTowerGuard,
  towerWorkspaceOwned,
} from '../../src/guards/bashGuard.ts';

const repo = '/work/repo';
const slot = join(repo, '.tower', 'worktrees', 'wt-1');
const home = '/home/tester';

const ESCAPE =
  'to retire the tower workspace deliberately, turn tower mode off and remove .tower/comms manually in a terminal — this guard only intercepts agent Bash calls.';
const GIT_CLEAN_VETO =
  '`git clean` with force and -x/-X is not allowed when its scope covers the tower main checkout — it would delete .tower/comms, the tower protocol state, which git does not track and cannot restore. Run the clean inside your own tower worktree or a temporary `git worktree add` checkout instead; ' +
  ESCAPE;
const GIT_RESET_VETO =
  '`git reset --hard` is not allowed in the tower main checkout — it would silently discard base-checkout work the tower fleet depends on. Run it inside your own tower worktree or a temporary worktree instead; ' +
  ESCAPE;
const UNANALYZABLE_VETO =
  'this Bash command mentions git clean / git reset / rm and the tower guard could not parse it safely, so it is blocked conservatively — a misread command could delete .tower/comms, the tower protocol state. Split it into simpler commands or run it inside your tower worktree.';

function rmVeto(operand: string): string {
  return `\`rm\` is not allowed on tower protocol paths ("${operand}") — .tower/comms holds the tower protocol state and deleting it orphans the fleet. Remove paths inside your own worktree instead; ${ESCAPE}`;
}

function guard(command: string, cwd: string = repo, homeDir: string = home): string | undefined {
  return analyzeTowerBashCommand({ command, cwd, mainCheckout: repo, home: homeDir });
}

function nestBash(command: string, levels: number): string {
  let wrapped = command;
  for (let level = 0; level < levels; level += 1) {
    wrapped = `bash -c '${wrapped.replaceAll("'", "'\\''")}'`;
  }
  return wrapped;
}

describe('commandNeedsTowerGuard', () => {
  it.each(['rm -rf build', 'git clean -fdx', 'git reset --hard', 'sudo rm x', 'git -C wt clean -n'])(
    'flags "%s"',
    (command) => {
      expect(commandNeedsTowerGuard(command)).toBe(true);
    },
  );

  it.each(['ls -la && git status', 'echo format armory cleanup resetting', 'npm run clean', 'reset'])(
    'passes "%s" without analysis',
    (command) => {
      expect(commandNeedsTowerGuard(command)).toBe(false);
      expect(guard(command)).toBeUndefined();
    },
  );

  it.each(["r\\m -rf .tower", "'r'm -rf .tower", 'g"i"t cl\'\'ean -fdx', 'r\\\nm -rf .tower', 'RM -rf .tower', 'Git Reset --hard'])(
    'still flags the quoted, escaped or upper-case keyword in "%s"',
    (command) => {
      expect(commandNeedsTowerGuard(command)).toBe(true);
    },
  );

  it('ignores unanalyzable constructs when no guarded keyword is present', () => {
    expect(guard('echo $(date) && (cd sub && make) && cat <<EOF\nx\nEOF')).toBeUndefined();
  });
});

describe('git clean', () => {
  it.each([
    'git clean -fdx',
    'git clean -ffdx',
    'git clean -fx',
    'git clean -f -d -x',
    'git clean --force -dx',
    'git clean -fdx .',
    'git clean -fdx .tower',
    'git clean -fdx -- .tower/comms',
    'git clean -fdX -- .tower/comms',
    'git clean -fdx .tower/comms/state.json',
  ])('vetoes "%s" at the main checkout', (command) => {
    expect(guard(command)).toBe(GIT_CLEAN_VETO);
  });

  it('vetoes git clean targeting the main checkout from outside via git -C', () => {
    expect(guard(`git -C ${repo} clean -fdx`, '/tmp')).toBe(GIT_CLEAN_VETO);
  });

  it.each([
    'git clean -ndx',
    'git clean -n',
    'git clean --dry-run -fdx',
    'git clean -fdxn',
    'git clean -f',
    'git clean -fd',
    'git clean -ffd',
    'git clean --force -d',
    'git clean -fd .tower',
    'git clean -fd -- .tower/comms',
    'git clean -fd .tower/comms/state.json',
    'git clean -fdx packages',
    'git clean -fdx -i',
    'git clean -dx',
  ])('allows "%s" (dry-run, interactive, no -x/-X, no force, or out-of-scope pathspec)', (command) => {
    expect(guard(command)).toBeUndefined();
  });

  it('allows git clean and git reset --hard inside a tower worktree', () => {
    for (const command of [
      `cd ${slot} && git clean -fdx`,
      `cd ${slot} && git clean -fdx .`,
      `cd ${slot} && git clean -fdx ./`,
      `cd ${slot} && git clean -fdx -- .`,
      `cd ${slot} && git clean -fdx node_modules`,
      `cd ${join(slot, 'pkg')} && git clean -fdx ..`,
      `git -C ${slot} clean -fdx`,
      `git -C ${slot} clean -fdx .`,
      `cd ${slot} && git reset --hard`,
      `git -C ${slot} reset --hard HEAD~1`,
    ]) {
      expect(guard(command), command).toBeUndefined();
    }
  });

  it('allows git clean with a dot pathspec when the Bash cwd is a worktree', () => {
    for (const command of ['git clean -fdx', 'git clean -fdx .', 'git clean -fdx -- .']) {
      expect(guard(command, slot), command).toBeUndefined();
    }
  });

  it('still vetoes git clean naming a worktree slot root from the main checkout', () => {
    for (const command of [
      'git clean -fdx .tower/worktrees/wt-1',
      'git clean -ffdx .tower/worktrees/wt-1',
      `git clean -fdx ${slot}`,
    ]) {
      expect(guard(command), command).toBe(GIT_CLEAN_VETO);
    }
  });

  it('still vetoes git clean whose pathspec escapes a worktree slot into tower protocol paths', () => {
    expect(guard(`cd ${slot} && git clean -fdx ../../comms`)).toBe(GIT_CLEAN_VETO);
  });

  it('keeps -e / --exclude values out of the pathspecs', () => {
    const packages = join(repo, 'packages');
    for (const command of [
      'git clean -fdx -e ../.tower',
      'git clean -fdxe ../.tower',
      'git clean -fdx --exclude ../.tower',
      'git clean -fdx --exclude=../.tower',
      'git clean -fdx -e "$KEEP"',
    ]) {
      expect(guard(command, packages), command).toBeUndefined();
    }
    expect(guard('git clean -fdx ../.tower', packages)).toBe(GIT_CLEAN_VETO);
  });

  it('vetoes pathspec magic conservatively', () => {
    expect(guard('git clean -fdx :/', join(repo, 'packages'))).toBe(UNANALYZABLE_VETO);
  });
});

describe('git reset --hard', () => {
  it.each(['git reset --hard', 'git reset --hard HEAD~1', 'git reset --hard origin/main', 'git reset -q --hard @{u}'])(
    'vetoes "%s" at the main checkout',
    (command) => {
      expect(guard(command)).toBe(GIT_RESET_VETO);
    },
  );

  it('vetoes it in the tower root and the worktrees directory itself', () => {
    expect(guard('git reset --hard', join(repo, '.tower'))).toBe(GIT_RESET_VETO);
    expect(guard('git reset --hard', join(repo, '.tower', 'worktrees'))).toBe(GIT_RESET_VETO);
    expect(guard('git reset --hard', join(repo, 'packages', 'core'))).toBe(GIT_RESET_VETO);
  });

  it.each(['git reset', 'git reset --soft HEAD~1', 'git reset --mixed', 'git reset --keep HEAD~1'])(
    'allows "%s" without --hard',
    (command) => {
      expect(guard(command)).toBeUndefined();
    },
  );

  it('vetoes git -C reset --hard whose target is the main checkout even from a worktree cwd', () => {
    expect(guard(`git -C ${repo} reset --hard`, slot)).toBe(GIT_RESET_VETO);
  });

  it('allows git reset --hard outside the main checkout', () => {
    expect(guard('git reset --hard', '/srv/other-repo')).toBeUndefined();
    expect(guard(`git -C /srv/other-repo reset --hard`)).toBeUndefined();
  });
});

describe('rm', () => {
  it.each([
    ['rm -rf .tower', '.tower'],
    ['rm -rf .tower/comms', '.tower/comms'],
    ['rm -f .tower/comms/state.json', '.tower/comms/state.json'],
    ['rm --recursive --force .tower', '.tower'],
    ['rm -rf .tower/worktrees', '.tower/worktrees'],
    ['rm -r .tower/agents', '.tower/agents'],
    ['rm -R .tower/worktrees/wt-1', '.tower/worktrees/wt-1'],
    ['rm -rf -- .tower', '.tower'],
    ['rm .tower/comms/inbox/x.md', '.tower/comms/inbox/x.md'],
    ['rm -rf build .tower', '.tower'],
  ])('vetoes "%s" on tower protocol paths', (command, operand) => {
    expect(guard(command)).toBe(rmVeto(operand));
  });

  it('vetoes recursive rm of the main checkout root and its ancestors', () => {
    expect(guard(`rm -rf ${repo}`)).toBe(rmVeto(repo));
    expect(guard('rm -rf /work')).toBe(rmVeto('/work'));
    expect(guard('rm -rf /')).toBe(rmVeto('/'));
    expect(guard('rm -rf .', repo)).toBe(rmVeto('.'));
  });

  it('allows non-recursive rm of tower directories, which rm cannot delete', () => {
    expect(guard('rm .tower')).toBeUndefined();
    expect(guard('rm -f .tower/worktrees')).toBeUndefined();
  });

  it.each(['rm -rf node_modules', 'rm -f README.md', 'rm -rf .tmp', 'rm -rf .towerish', 'rm -rf /tmp/scratch'])(
    'allows "%s" on ordinary paths',
    (command) => {
      expect(guard(command)).toBeUndefined();
    },
  );

  it('allows rm -rf inside a worktree slot', () => {
    expect(guard(`rm -rf ${join(slot, 'node_modules')}`)).toBeUndefined();
    expect(guard(`cd ${slot} && rm -rf node_modules dist`)).toBeUndefined();
    expect(guard('rm -rf node_modules', slot)).toBeUndefined();
    expect(guard('rm -rf .tower/worktrees/wt-1/dist')).toBeUndefined();
  });

  it('still vetoes rm of the slot root and of comms reached from a slot', () => {
    expect(guard(`rm -rf ${slot}`)).toBe(rmVeto(slot));
    expect(guard('rm ../../comms/state.json', slot)).toBe(rmVeto('../../comms/state.json'));
  });

  it('expands ~ against the home directory', () => {
    expect(guard('rm -rf ~/repo/.tower', '/tmp', '/work')).toBe(rmVeto('~/repo/.tower'));
    expect(guard('rm -rf ~', '/tmp', '/work')).toBe(rmVeto('~'));
    expect(guard('rm -rf ~/scratch', '/tmp', '/work')).toBeUndefined();
  });
});

describe('cwd tracking', () => {
  it('tracks cd chains across && lists', () => {
    expect(guard('cd packages && git clean -fdx')).toBeUndefined();
    expect(guard('cd packages && cd .. && git clean -fdx')).toBe(GIT_CLEAN_VETO);
  });

  it('runs the command after ; or a newline whether the cd before it succeeded or failed', () => {
    expect(guard(`cd ${slot}; git reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard(`cd ${slot}\ngit clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`cd ${slot}; git reset --hard`, slot)).toBeUndefined();
    expect(guard(`cd ${slot}; rm -rf node_modules`)).toBeUndefined();
    expect(guard(`cd ${slot} && cd ../.. && git reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard('cd .tower && rm -rf comms')).toBe(rmVeto('comms'));
    expect(guard('cd .tower/worktrees/wt-1 && rm -rf node_modules')).toBeUndefined();
  });

  it('carries both outcomes of a negated cd into the next statement', () => {
    expect(guard(`! cd ${repo}; git reset --hard`, slot)).toBe(GIT_RESET_VETO);
    expect(guard(`! cd ${slot}; git reset --hard`)).toBe(GIT_RESET_VETO);
  });

  it('analyzes the right-hand side of || in the cwd where the left side failed', () => {
    expect(guard(`cd ${slot} || git clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`cd ${slot} || exit 1; git clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`cd ${slot} || exit 1; git clean -fdx`, slot)).toBeUndefined();
    expect(guard(`cd ${slot} || echo missing; git clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`! cd ${slot} || git reset --hard`)).toBeUndefined();
  });

  it('does not carry cd out of background jobs, pipelines or child shells', () => {
    expect(guard(`cd ${slot} & git clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`cd ${slot} | cat; git reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard(`bash -c 'cd ${slot}' && git clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`env cd ${slot} && git reset --hard`)).toBe(GIT_RESET_VETO);
  });

  it('carries cd through eval and current-shell wrappers', () => {
    expect(guard(`eval "cd ${slot}" && git clean -fdx`)).toBeUndefined();
    expect(guard(`eval cd ${repo}; git reset --hard`, slot)).toBe(GIT_RESET_VETO);
    expect(guard(`builtin cd ${slot} && git reset --hard`)).toBeUndefined();
    expect(guard(`command cd ${slot} && git reset --hard`)).toBeUndefined();
  });

  it('resolves cd without an operand and cd ~ to the home directory', () => {
    expect(guard('cd && rm -rf repo/.tower', '/tmp', '/work')).toBe(rmVeto('repo/.tower'));
    expect(guard('cd ~/repo && git clean -fdx', '/tmp', '/work')).toBe(GIT_CLEAN_VETO);
  });

  it('stops trusting ~ and bare cd once HOME is reassigned', () => {
    expect(guard(`HOME=${repo}; cd && git clean -fdx`, slot, '/work')).toBe(UNANALYZABLE_VETO);
    expect(guard(`HOME=${repo} cd && git reset --hard`, slot, '/work')).toBe(UNANALYZABLE_VETO);
    expect(guard(`export HOME=${repo}; rm -rf ~/.tower`, slot, '/work')).toBe(UNANALYZABLE_VETO);
    expect(guard(`env HOME=${repo} bash -c 'rm -rf ~/x'`, slot, '/work')).toBe(UNANALYZABLE_VETO);
    expect(guard(`HOME=${repo}; rm -rf ${slot}/node_modules`, slot, '/work')).toBeUndefined();
  });

  it('treats cd "" as a no-op', () => {
    expect(guard('cd "" && git reset --hard')).toBe(GIT_RESET_VETO);
    expect(guard('cd "" && git reset --hard', slot)).toBeUndefined();
  });

  it('loses the cwd on cd -, dynamic or ambiguous cd and popd, and vetoes what then depends on it', () => {
    expect(guard('cd - && rm -rf build')).toBe(UNANALYZABLE_VETO);
    expect(guard(`cd - && rm -rf ${repo}/.tower/comms`)).toBe(rmVeto(`${repo}/.tower/comms`));
    expect(guard('cd "$DIR" && git clean -fdx')).toBe(UNANALYZABLE_VETO);
    expect(guard('cd "$DIR" && git reset --soft HEAD~1')).toBeUndefined();
    expect(guard('cd a b && rm -rf build')).toBe(UNANALYZABLE_VETO);
    expect(guard(`pushd ${slot} && git clean -fdx && popd`)).toBeUndefined();
    expect(guard(`pushd ${slot} && popd && rm -rf build`)).toBe(UNANALYZABLE_VETO);
    expect(guard(`cd - && rm -rf /tmp/scratch`)).toBeUndefined();
  });

  it('follows git -C relative to the tracked cwd', () => {
    expect(guard('git -C .tower/worktrees/wt-1 clean -fdx')).toBeUndefined();
    expect(guard('git -C .tower clean -fdx')).toBe(GIT_CLEAN_VETO);
    expect(guard(`git -C ${slot} -C ../.. reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard(`cd ${slot} && git -C ../../.. reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard('git -C "$WT" reset --hard')).toBe(UNANALYZABLE_VETO);
    expect(guard('git -C "$WT" status && rm -rf build')).toBeUndefined();
  });
});

describe('wrappers and nested shells', () => {
  it.each([
    ["bash -c 'git clean -fdx'", GIT_CLEAN_VETO],
    ['sudo rm -rf .tower', rmVeto('.tower')],
    ['env FOO=1 git reset --hard', GIT_RESET_VETO],
    ['eval "git clean -fdx"', GIT_CLEAN_VETO],
  ])('vetoes "%s" through wrappers and nested shells', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it.each([
    'sudo -u root rm -rf .tower',
    'sudo -E -- rm -rf .tower',
    '/usr/bin/sudo /bin/rm -rf .tower',
    'doas -u root rm -rf .tower',
    'env -i PATH=/bin rm -rf .tower',
    'env - rm -rf .tower',
    'command rm -rf .tower',
    'command -p rm -rf .tower',
    'exec rm -rf .tower',
    'nohup rm -rf .tower &',
    'nice -n 10 rm -rf .tower',
    'time rm -rf .tower',
    'builtin command rm -rf .tower',
    'busybox rm -rf .tower',
    'FOO=1 BAR="a b" rm -rf .tower',
    'sudo env FOO=1 nice rm -rf .tower',
  ])('vetoes "%s"', (command) => {
    expect(guard(command)).toBe(rmVeto('.tower'));
  });

  it('applies sudo -D and env -C to the wrapped command', () => {
    expect(guard(`sudo -D ${slot} git clean -fdx`)).toBeUndefined();
    expect(guard(`sudo --chdir=${repo} git clean -fdx`, slot)).toBe(GIT_CLEAN_VETO);
    expect(guard(`env -C ${slot} git clean -fdx`)).toBeUndefined();
    expect(guard(`env --chdir ${repo} git reset --hard`, slot)).toBe(GIT_RESET_VETO);
    expect(guard(`env -C${repo} git reset --hard`, slot)).toBe(GIT_RESET_VETO);
    expect(guard(`env -C "$DIR" git reset --hard`, slot)).toBe(UNANALYZABLE_VETO);
  });

  it('vetoes env -S conservatively', () => {
    expect(guard("env -S 'git clean -fdx'")).toBe(UNANALYZABLE_VETO);
    expect(guard("env --split-string='rm -rf .tower'")).toBe(UNANALYZABLE_VETO);
  });

  it.each([
    ['sh -c "rm -rf .tower"', rmVeto('.tower')],
    ["bash -lc 'git reset --hard'", GIT_RESET_VETO],
    ["bash -o pipefail -c 'rm -rf .tower'", rmVeto('.tower')],
    ["bash -c -e 'rm -rf .tower'", rmVeto('.tower')],
    ["bash -c -- 'rm -rf .tower'", rmVeto('.tower')],
    ["bash --norc -c 'rm -rf .tower' arg0 arg1", rmVeto('.tower')],
    ["dash -c 'rm -rf .tower'", rmVeto('.tower')],
    ["ksh -c 'rm -rf .tower'", rmVeto('.tower')],
    ["ash -c 'rm -rf .tower'", rmVeto('.tower')],
    [`zsh -c 'bash -c "rm -rf .tower"'`, rmVeto('.tower')],
    ["/bin/sh -c 'cd .tower && rm -rf comms'", rmVeto('comms')],
    ["sudo bash -c 'git clean -fdx'", GIT_CLEAN_VETO],
  ])('re-parses the nested script in "%s"', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it('re-parses quoted scripts that contain $, globs or brackets', () => {
    expect(guard("bash -c 'echo $HOME; rm -rf .tower/comms'")).toBe(rmVeto('.tower/comms'));
    expect(guard("bash -c '[ -d build ] && rm -rf build'")).toBeUndefined();
    expect(guard("bash -c 'rm -f *.log'", slot)).toBeUndefined();
    expect(guard("bash -c 'rm -rf .tower/*'")).toBe(UNANALYZABLE_VETO);
    expect(guard("bash -c 'cd \"$HOME\" && rm -rf .tower'")).toBe(UNANALYZABLE_VETO);
    expect(guard("eval '[ -d build ] && rm -rf build'")).toBeUndefined();
    expect(guard("eval '[ -d .tower ] && rm -rf .tower'")).toBe(rmVeto('.tower'));
    expect(guard(`trap '[ -n "$tmp" ] && rm -rf ${repo}/.tower/comms' EXIT`)).toBe(rmVeto(`${repo}/.tower/comms`));
  });

  it('allows nested scripts that are safe', () => {
    expect(guard(`bash -c 'cd ${slot} && git clean -fdx'`)).toBeUndefined();
    expect(guard("bash -c 'echo rm -rf .tower'")).toBeUndefined();
    expect(guard("bash -c ''")).toBeUndefined();
    expect(guard('bash scripts/build.sh && rm -rf node_modules')).toBeUndefined();
    expect(guard('bash --version && rm -rf node_modules')).toBeUndefined();
  });

  it('re-parses nested scripts up to depth 4 and vetoes deeper nesting', () => {
    expect(guard(nestBash('rm -rf .tower', 4))).toBe(rmVeto('.tower'));
    expect(guard(nestBash('rm -rf build', 4))).toBeUndefined();
    expect(guard(nestBash('rm -rf build', 5))).toBe(UNANALYZABLE_VETO);
  });

  it('re-parses trap actions with an unknown cwd and vetoes alias definitions', () => {
    expect(guard("trap 'rm -rf .tower/comms' EXIT")).toBe(UNANALYZABLE_VETO);
    expect(guard(`trap -- 'rm -rf ${repo}/.tower' EXIT`)).toBe(rmVeto(`${repo}/.tower`));
    expect(guard("trap 'rm -f /tmp/guard.lock' EXIT; rm -f build.log")).toBeUndefined();
    expect(guard('trap "$CLEANUP" EXIT; rm -f x')).toBe(UNANALYZABLE_VETO);
    expect(guard('trap - EXIT; trap -p; trap EXIT; rm -f x')).toBeUndefined();
    expect(guard("alias x='rm -rf .tower'")).toBe(UNANALYZABLE_VETO);
    expect(guard('alias; rm -f x')).toBeUndefined();
  });

  it('vetoes shells that read their script from stdin', () => {
    expect(guard("echo 'rm -rf .tower' | bash")).toBe(UNANALYZABLE_VETO);
    expect(guard("bash <<< 'rm -rf .tower'")).toBe(UNANALYZABLE_VETO);
    expect(guard("sh -s < cleanup.txt && rm -f x")).toBe(UNANALYZABLE_VETO);
    expect(guard("bash script.sh -c 'rm -rf .tower'")).toBe(UNANALYZABLE_VETO);
  });

  it.each([
    "bash /dev/stdin <<< 'rm -rf .tower/comms'",
    'sh /dev/fd/0 < cleanup.sh && rm -f x',
    "bash /proc/self/fd/0 <<< 'rm -rf .tower/comms'",
    "bash /dev/fd/3 3<<< 'rm -rf .tower/comms'",
    "bash -x -- //dev/./stdin <<< 'rm -rf .tower/comms'",
    "zsh /dev/stdin <<< 'git reset --hard'",
    "source /dev/stdin <<< 'rm -rf .tower/comms'",
    ". /dev/fd/0 <<< 'rm -rf .tower/comms'",
    "builtin source -- /dev/stdin <<< 'git reset --hard'",
    "cd /dev && source ./stdin <<< 'rm -rf .tower/comms'",
  ])('vetoes the stdin script operand in %j', (command) => {
    expect(guard(command)).toBe(UNANALYZABLE_VETO);
  });

  it('still allows sourcing and running script files', () => {
    expect(guard('source .venv/bin/activate && rm -rf build')).toBeUndefined();
    expect(guard('. ./env.sh; rm -f x')).toBeUndefined();
    expect(guard('bash scripts/clean.sh; rm -rf node_modules')).toBeUndefined();
  });
});

describe('wrapper long options', () => {
  it.each([
    ['env --ch=.tower rm -rf comms', rmVeto('comms')],
    ['env --chd .tower rm -rf comms', rmVeto('comms')],
    ['env --unse PATH rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['env --ignore-env rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['sudo --us root rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['sudo --preserve-env=PATH rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['nice --adj=5 rm -rf .tower/comms', rmVeto('.tower/comms')],
    ["env --spl='rm -rf .tower/comms'", UNANALYZABLE_VETO],
    ['env --i rm -rf .tower/comms', UNANALYZABLE_VETO],
    ['env --frobnicate rm -f x', UNANALYZABLE_VETO],
    [`sudo --ch ${slot} git clean -fdx`, UNANALYZABLE_VETO],
    ['command --help; rm -f x', UNANALYZABLE_VETO],
  ])('resolves unique abbreviations and vetoes unknown options in %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it('applies an abbreviated chdir option to the wrapped command', () => {
    expect(guard(`env --chd ${slot} git clean -fdx`)).toBeUndefined();
    expect(guard(`sudo --chd=${slot} git clean -fdx`)).toBeUndefined();
    expect(guard(`env --ch=${repo} git reset --hard`, slot)).toBe(GIT_RESET_VETO);
  });
});

describe('zsh precommand modifiers', () => {
  it.each([
    ["zsh -c 'noglob rm -rf .tower/comms'", rmVeto('.tower/comms')],
    ["zsh -c 'nocorrect rm -rf .tower/comms'", rmVeto('.tower/comms')],
    ["zsh -c 'true; - rm -rf .tower/comms'", rmVeto('.tower/comms')],
    ["zsh -c '=rm -rf .tower/comms'", rmVeto('.tower/comms')],
    ["zsh -c 'repeat 1 rm -rf .tower/comms'", UNANALYZABLE_VETO],
    ["zsh -c 'foreach x (a) rm -rf .tower/comms; end'", UNANALYZABLE_VETO],
  ])('analyzes %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it('carries cd through noglob like the current shell', () => {
    expect(guard(`noglob cd ${slot} && git reset --hard`)).toBeUndefined();
    expect(guard(`noglob cd ${repo} && git reset --hard`, slot)).toBe(GIT_RESET_VETO);
  });
});

describe('quoting and parsing', () => {
  it('allows a command that only mentions the keywords in string literals', () => {
    for (const command of [
      'echo "git clean -fdx" && printf "rm -rf"',
      'echo "rm"',
      'echo rm -rf .tower',
      'echo "a; rm -rf .tower"',
      'echo a \\; rm -rf .tower',
      "printf '%s\\n' 'rm -rf .tower'",
      'git commit -m "chore: rm stale files and reset docs"',
      'grep -rn "git reset --hard" src',
    ]) {
      expect(guard(command), command).toBeUndefined();
    }
  });

  it.each([
    ['rm -rf ".tower"', '.tower'],
    ["rm -rf '.tower/comms'", '.tower/comms'],
    ['rm -rf .tower/"comms"', '.tower/comms'],
    ['rm -rf .\\tower', '.tower'],
    ['"rm" -rf .tower', '.tower'],
    ['r\\m -rf .tower', '.tower'],
    ["'/bin/rm' -rf .tower", '.tower'],
    ['rm -rf \\\n  .tower', '.tower'],
    ['rm -rf ".tower/comms/"', '.tower/comms/'],
  ])('resolves quoted and escaped operands in "%s"', (command, operand) => {
    expect(guard(command)).toBe(rmVeto(operand));
  });

  it('allows quoted operands that are ordinary paths', () => {
    expect(guard('rm -rf "node modules"')).toBeUndefined();
    expect(guard("rm -rf 'it'\\''s here'")).toBeUndefined();
    expect(guard('rm -rf ".tower backup"')).toBeUndefined();
  });

  it.each([
    'ls; rm -rf .tower',
    'false || rm -rf .tower',
    'cat list | rm -rf .tower',
    'ls |& rm -rf .tower',
    'sleep 1 & rm -rf .tower',
    'ls\nrm -rf .tower',
    'ls &&\n  rm -rf .tower',
    'echo a#b; rm -rf .tower',
    'ls #comment\nrm -rf .tower',
    'rm -rf .tower 2>/dev/null || true',
    '[[ -d .tower ]] && rm -rf .tower',
  ])('splits "%s" into commands', (command) => {
    expect(guard(command)).toBe(rmVeto('.tower'));
  });

  it('ignores comments, redirections and test brackets', () => {
    expect(guard('ls # rm -rf .tower')).toBeUndefined();
    expect(guard('# rm -rf .tower\nls')).toBeUndefined();
    expect(guard('rm -rf node_modules &>/dev/null')).toBeUndefined();
    expect(guard('rm -rf build > log.txt 2>&1')).toBeUndefined();
    expect(guard('[ -d build ] && rm -rf build')).toBeUndefined();
    expect(guard('test -d build && rm -rf build')).toBeUndefined();
  });
});

describe('conservative vetoes', () => {
  it.each([
    'rm -rf $(pwd)/.tower',
    'rm -rf `pwd`/.tower',
    'echo "$(rm -rf .tower)"',
    'X=$(rm -rf .tower)',
    '{ rm -rf .tower; }',
    '((1 + 2)) && rm -f x',
    'cat <<EOF\nrm -rf .tower\nEOF',
    "cat <<'EOF' > notes.md\nrm -rf build\nEOF",
    'diff <(ls) <(ls); rm -f x',
    'if true; then rm -rf build; fi',
    'for f in a b; do rm -f "$f"; done',
    'while true; do git reset --hard; done',
    'case x in a) rm -rf a;; esac',
    'f() { rm -rf .tower; }',
    'echo $((1 + 2)); rm -f x',
    'rm -rf $DIR',
    'rm -rf "$HOME/x"',
    'rm -rf ${TMPDIR}/x',
    "rm -rf $'.tower'",
    'rm -rf .tower/*',
    'rm -rf build?',
    'rm -rf {a,b}',
    'rm -rf ~other/x',
    'X=rm; $X -rf .tower',
    '"$RM" -rf .tower',
    'sudo $CMD rm -rf x',
    'git clean -fdx $EXTRA',
    "git clean -fdx '*.log'",
    'git $SUB -fdx && git clean -n',
    'git reset "$MODE"',
    'eval "$CMD" && rm -f x',
    "bash -c \"$SCRIPT\" && rm -f x",
    'git clean -fdx "',
    "rm -rf 'unterminated",
    'rm -f x\r',
    'ls | ! rm -rf build',
  ])('vetoes "%s" with the unanalyzable message', (command) => {
    expect(guard(command)).toBe(UNANALYZABLE_VETO);
  });

  it('allows dynamic words outside guarded positions', () => {
    for (const command of [
      'echo "$HOME" && rm -rf node_modules',
      'git commit -m "$MSG" && git reset --soft HEAD~1',
      `cd ${slot} && git reset --hard "$REF"`,
      'git status --porcelain && rm -f "notes.txt"',
      'find . -name "*.orig" -exec rm {} +',
      'npm test -- --grep "$PATTERN"; rm -f coverage.json',
    ]) {
      expect(guard(command), command).toBeUndefined();
    }
  });

  it('prefers the specific veto when a literal operand is already protected', () => {
    expect(guard('git reset --hard "$REF"')).toBe(GIT_RESET_VETO);
    expect(guard('rm -rf .tower/comms "$X"')).toBe(rmVeto('.tower/comms'));
  });

  it('vetoes commands beyond the parse budget', () => {
    expect(guard(`rm -f x${' y'.repeat(10_001)}`)).toBe(UNANALYZABLE_VETO);
  });
});

describe('exit and sequential statements', () => {
  it.each([
    ['[ -f done.flag ] && exit 0; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['test -d dist && exit; git clean -fdx', GIT_CLEAN_VETO],
    ['git diff --quiet && exit 0\ngit reset --hard', GIT_RESET_VETO],
    ['false && exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['[ -f done.flag ] && exit 0\nrm -rf .tower/comms', rmVeto('.tower/comms')],
    ['test -d dist && exit\n\ngit clean -fdx', GIT_CLEAN_VETO],
    ["bash -c '[ -f done.flag ] && exit 0; rm -rf .tower/comms'", rmVeto('.tower/comms')],
    ["bash -c 'test -d dist && exit\ngit clean -fdx'", GIT_CLEAN_VETO],
    ["sh -c 'git diff --quiet && exit 0; git reset --hard'", GIT_RESET_VETO],
    ["eval 'false && exit'; rm -rf .tower/comms", rmVeto('.tower/comms')],
    ['eval "test -d dist && exit"\ngit clean -fdx', GIT_CLEAN_VETO],
    ['exit >/nonexistent/x; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit 2>/dev/null; git reset --hard', GIT_RESET_VETO],
    ['builtin exit >/nonexistent/x\nrm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit 1 </nonexistent/x || git clean -fdx', GIT_CLEAN_VETO],
    ['(exit); rm -rf .tower/comms', rmVeto('.tower/comms')],
  ])('keeps analyzing what runs after a conditional or redirected exit in %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it.each([
    ['exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit 0\ngit clean -fdx', GIT_CLEAN_VETO],
    ['exit 300; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit $?; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit "$?"\ngit reset --hard', GIT_RESET_VETO],
    ['exit >/dev/null && rm -rf .tower/comms', rmVeto('.tower/comms')],
    [`cd ${slot} || exit 1; git clean -fdx`, GIT_CLEAN_VETO],
    [`cd ${slot} || exit 1; git reset --hard`, GIT_RESET_VETO],
    [`cd ${slot} || exit 1\ngit reset --hard`, GIT_RESET_VETO],
    [`cd ${slot} || exit $?; git reset --hard`, GIT_RESET_VETO],
  ])('never treats exit as the end of the script in %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it('still allows exit idioms whose later statements are safe where they run', () => {
    expect(guard(`cd ${slot} || exit 1; git reset --hard`, slot)).toBeUndefined();
    expect(guard(`cd ${slot} || exit 1\ngit clean -fdx`, slot)).toBeUndefined();
    expect(guard('exit 0; rm -rf node_modules', slot)).toBeUndefined();
    expect(guard('[ -d build ] || exit 0; rm -rf build')).toBeUndefined();
  });

  it.each([
    ['noglob exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['nocorrect exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['true; - exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['noglob exit\ngit reset --hard', GIT_RESET_VETO],
    ['cd .tower/worktrees/wt-9 || noglob exit 1; git reset --hard', GIT_RESET_VETO],
    ['command -v exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['command -pv exit && rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['command -V exit; git clean -fdx', GIT_CLEAN_VETO],
    ['\\time exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['"time" exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['/usr/bin/time exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['time -v exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['time -f %e exit; git reset --hard', GIT_RESET_VETO],
    ['builtin -x exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['command -x exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['/usr/bin/command exit; rm -rf .tower/comms', rmVeto('.tower/comms')],
  ])('keeps analyzing after an exit reached through a wrapper in %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it.each([
    ['exit --help; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit --help\ngit reset --hard', GIT_RESET_VETO],
    ['\\exit --help; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['builtin exit --help; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['command exit --help; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ["eval 'exit --help'; rm -rf .tower/comms", rmVeto('.tower/comms')],
    ["bash -c 'exit --help; rm -rf .tower/comms'", rmVeto('.tower/comms')],
    ['(cd .tower; exit --help; rm -rf comms)', rmVeto('comms')],
    ['exit --help || git clean -fdx', GIT_CLEAN_VETO],
    ['exit 1 2; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit foo; git clean -fdx', GIT_CLEAN_VETO],
    ['exit -1; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit -- 0; rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exit "$CODE"\ngit reset --hard', GIT_RESET_VETO],
  ])('keeps analyzing after an exit that may return in %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it.each([
    'enable -n exit; exit; rm -rf .tower/comms',
    'builtin enable -n exit\nexit\nrm -rf .tower/comms',
    "bash -c 'enable -n exit; exit; rm -rf .tower/comms'",
    "eval 'enable -n exit'; exit; git reset --hard",
    'enable; rm -f x',
  ])('vetoes %j because enable can disable builtins', (command) => {
    expect(guard(command)).toBe(UNANALYZABLE_VETO);
  });
});

describe('pipelines', () => {
  it("carries the last element's cd forward for lastpipe and zsh/ksh pipelines", () => {
    expect(guard('shopt -s lastpipe; true | cd .tower; rm -rf comms')).toBe(rmVeto('comms'));
    expect(guard("zsh -c 'true | cd .tower; rm -rf comms'")).toBe(rmVeto('comms'));
    expect(guard("ksh -c 'printf x | cd .tower && rm -rf comms'")).toBe(rmVeto('comms'));
    expect(guard(`true | cd ${slot}; git reset --hard`)).toBe(GIT_RESET_VETO);
  });

  it('keeps the input cwd for every pipeline element', () => {
    expect(guard(`cd ${slot} | cat; git reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard(`true | cd ${slot}; git reset --hard`, slot)).toBeUndefined();
    expect(guard('ls | grep x; rm -rf node_modules')).toBeUndefined();
    expect(guard('true | exit; rm -rf .tower/comms')).toBe(rmVeto('.tower/comms'));
  });
});

describe('git clean option clusters', () => {
  it.each([
    'git clean -fdxe.env',
    'git clean -xfde_build',
    'git clean -fdxe/node_modules',
    'git clean -fdx -e.env',
    'git clean -dfx -e.idea -e.vscode',
    'git clean -fdxe .env',
    'git clean -fd -x -e.cache -- ',
    'git clean -qfdx',
  ])('vetoes %j at the main checkout', (command) => {
    expect(guard(command)).toBe(GIT_CLEAN_VETO);
  });

  it('never treats a dash-leading argument before -- as a pathspec', () => {
    expect(guard('git clean -fdx -e.env', join(repo, 'packages'))).toBeUndefined();
    expect(guard('git clean -fdx -e.tower/comms', join(repo, 'packages'))).toBeUndefined();
    expect(guard('git clean -fdx -- -e.env')).toBeUndefined();
  });

  it.each(['git clean -ndxe.env', 'git clean -fde.env', 'git clean -de.x', 'git clean -ie.env -fdx'])(
    'allows %j (dry-run, no -x, or an -x inside the exclude value)',
    (command) => {
      expect(guard(command)).toBeUndefined();
    },
  );

  it('allows clustered cleans inside a worktree', () => {
    expect(guard('git clean -fdxe.env', slot)).toBeUndefined();
    expect(guard(`cd ${slot} && git clean -dfx -e.idea -e.vscode`)).toBeUndefined();
  });
});

describe('bounded rm globs', () => {
  it.each(['rm -f dist/*.js', 'rm -rf build/*', 'rm -f *.log', 'rm -rf dist/ build/ *.tsbuildinfo', 'rm -rf .cache*'])(
    'allows %j inside a worktree',
    (command) => {
      expect(guard(command, slot)).toBeUndefined();
      expect(guard(`cd ${slot} && ${command}`)).toBeUndefined();
    },
  );

  it('allows globs whose directory is outside the main checkout and not above .tower', () => {
    expect(guard('rm -rf /tmp/pi-test-*')).toBeUndefined();
    expect(guard('rm -f ~/scratch/*.log', repo, '/work')).toBeUndefined();
    expect(guard(`rm -rf ${slot}/dist/*`)).toBeUndefined();
    expect(guard('rm -rf .tower/worktrees/wt-1/*')).toBeUndefined();
  });

  it.each([
    'rm -rf .tower/*',
    'rm -rf .t*',
    'rm -f *.log',
    'rm -rf ./*',
    'rm -rf .tower/worktrees/*',
    'rm -rf .tower/comms/*.md',
    'rm -rf /work/*',
    'rm -rf /*',
    'rm -rf ../*',
    'rm -rf */dist',
    'rm -rf dist*/x',
    'rm -rf "$OUT"/*',
    'rm -rf ~other/*',
    'rm -rf {dist,build}/*',
    'rm -rf -- -*',
  ])('vetoes %j at the main checkout', (command) => {
    expect(guard(command)).toBe(UNANALYZABLE_VETO);
  });

  it('vetoes globs that leave the worktree or sit in a non-final segment', () => {
    expect(guard('rm -rf ../*', slot)).toBe(UNANALYZABLE_VETO);
    expect(guard('rm -rf ../../comms/*', slot)).toBe(UNANALYZABLE_VETO);
    expect(guard('rm -rf */node_modules', slot)).toBe(UNANALYZABLE_VETO);
    expect(guard('rm -rf ~/*', repo, '/work')).toBe(UNANALYZABLE_VETO);
    expect(guard('cd - && rm -rf build/*')).toBe(UNANALYZABLE_VETO);
  });

  it('treats quoted glob characters as literal file names', () => {
    expect(guard('rm -rf "[ab]"')).toBeUndefined();
    expect(guard("rm -f 'a*b'")).toBeUndefined();
    expect(guard("rm -rf '.tower/comms'*")).toBe(UNANALYZABLE_VETO);
    expect(guard("rm -rf .tower/comms/'*'")).toBe(rmVeto('.tower/comms/*'));
  });

  it('still reports a protected literal operand next to a glob', () => {
    expect(guard('rm -rf ../../comms dist/*', slot)).toBe(rmVeto('../../comms'));
    expect(guard(`rm -rf ${repo}/.tower/comms *.log`, slot)).toBe(rmVeto(`${repo}/.tower/comms`));
  });
});

describe('git clean scope inside .tower', () => {
  it('vetoes a pathspec-less clean that runs inside .tower/comms', () => {
    expect(guard('cd .tower/comms/inbox && git clean -fdx')).toBe(GIT_CLEAN_VETO);
    expect(guard('git -C .tower/comms/missions clean -fdx')).toBe(GIT_CLEAN_VETO);
    expect(guard('git clean -fdx', join(repo, '.tower', 'comms'))).toBe(GIT_CLEAN_VETO);
  });

  it('vetoes a pathspec-less clean in .tower outside the worktree slots', () => {
    expect(guard('git clean -ffdx', join(repo, '.tower', 'worktrees'))).toBe(GIT_CLEAN_VETO);
    expect(guard(`cd ${slot} && cd .. && git clean -ffdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard('git -C .tower/agents clean -fdx')).toBe(GIT_CLEAN_VETO);
  });

  it('still allows the same clean at a slot root or below', () => {
    expect(guard('git clean -ffdx', slot)).toBeUndefined();
    expect(guard('git clean -fdx', join(slot, 'packages', 'core'))).toBeUndefined();
    expect(guard('git -C .tower/worktrees/wt-1 clean -ffdx')).toBeUndefined();
  });
});

describe('wrapper option clusters', () => {
  it.each([
    ["env -iS 'rm -rf .tower/comms'", UNANALYZABLE_VETO],
    ["env -vS'rm -rf .tower/comms'", UNANALYZABLE_VETO],
    ['sudo -Eu root rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['sudo -uroot rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['sudo -nEu root -- rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['sudo FOO=1 rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['sudo -u root FOO=1 BAR="a b" rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['doas -u root FOO=1 rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['nice -n10 rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['exec -cla name rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['time -p rm -rf .tower/comms', rmVeto('.tower/comms')],
    ['env -iu PATH rm -rf .tower/comms', rmVeto('.tower/comms')],
    ["echo 'rm -rf .tower/comms' | sudo -s", UNANALYZABLE_VETO],
    ['sudo -i < cleanup.sh && rm -f x', UNANALYZABLE_VETO],
    [`sudo GIT_DIR=${repo}/.git git -C ${slot} reset --hard`, UNANALYZABLE_VETO],
  ])('parses %j', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it('applies chdir options given inside a cluster', () => {
    expect(guard(`env -iC ${repo} git reset --hard`, slot)).toBe(GIT_RESET_VETO);
    expect(guard(`env -iC${repo} git reset --hard`, slot)).toBe(GIT_RESET_VETO);
    expect(guard(`env -iC ${slot} git clean -fdx`)).toBeUndefined();
    expect(guard(`sudo -nD ${slot} git clean -fdx`)).toBeUndefined();
    expect(guard(`sudo -nD${repo} git reset --hard`, slot)).toBe(GIT_RESET_VETO);
  });
});

describe('subshells', () => {
  it('analyzes commands inside ( … )', () => {
    expect(guard('(rm -rf .tower)')).toBe(rmVeto('.tower'));
    expect(guard('( (rm -rf .tower/comms) )')).toBe(rmVeto('.tower/comms'));
    expect(guard('(cd .tower && rm -rf comms) | cat')).toBe(rmVeto('comms'));
    expect(guard('ls && (cd sub && rm -rf build)')).toBeUndefined();
    expect(guard(`(cd ${slot} && git clean -fdx) && npm test`)).toBeUndefined();
  });

  it('does not carry cd or exit out of a subshell', () => {
    expect(guard(`(cd ${slot}) && git clean -fdx`)).toBe(GIT_CLEAN_VETO);
    expect(guard(`(cd ${slot} && exit) || git reset --hard`)).toBe(GIT_RESET_VETO);
    expect(guard('(exit 0) && rm -rf .tower/comms')).toBe(rmVeto('.tower/comms'));
  });

  it('vetoes subshells nested beyond the parser limit', () => {
    expect(guard(`${'( '.repeat(40)}rm -f x${' )'.repeat(40)}`)).toBe(UNANALYZABLE_VETO);
  });
});

describe('git target redirection', () => {
  it.each([
    `git --work-tree=${repo} -C ${slot} clean -fdx`,
    `git --work-tree ${repo} -C ${slot} reset --hard`,
    `git --git-dir ${repo}/.git clean -fdx`,
    'git -c clean.requireForce=false clean -dx',
    `git --config-env=core.worktree=WT -C ${slot} clean -fdx`,
    `GIT_DIR=${repo}/.git git -C ${slot} reset --hard`,
    `env GIT_WORK_TREE=${repo} git -C ${slot} clean -fdx`,
    `export GIT_WORK_TREE=${repo}; git -C ${slot} clean -fdx`,
    `GIT_INDEX_FILE=/tmp/index; cd ${slot} && git reset --hard`,
  ])('vetoes "%s" with the unanalyzable message', (command) => {
    expect(guard(command)).toBe(UNANALYZABLE_VETO);
  });

  it('allows redirection when the clean or reset cannot destroy anything', () => {
    expect(guard('git -c core.pager=cat clean -n')).toBeUndefined();
    expect(guard('git -c color.ui=never reset --soft HEAD~1')).toBeUndefined();
    expect(guard(`GIT_PAGER=cat git -C ${slot} reset --hard`)).toBeUndefined();
    expect(guard(`git --no-pager -C ${slot} clean -fdx`)).toBeUndefined();
  });
});

describe('option spellings', () => {
  it.each([
    ['git reset --har', GIT_RESET_VETO],
    ['git reset --h', GIT_RESET_VETO],
    ['git clean --forc -dx', GIT_CLEAN_VETO],
    ['git clean -n --no-dry-run -fdx', GIT_CLEAN_VETO],
    ['rm --rec .tower', rmVeto('.tower')],
    ['rm --r .tower', rmVeto('.tower')],
    ['RM -rf .tower', rmVeto('.tower')],
    ['rm.exe -rf .tower', rmVeto('.tower')],
    ['GIT reset --hard', GIT_RESET_VETO],
    ['git CLEAN -fdx', GIT_CLEAN_VETO],
  ])('treats "%s" like the full spelling', (command, veto) => {
    expect(guard(command)).toBe(veto);
  });

  it.each(['git clean -fdx --dry', 'git clean --inter -fdx', 'git reset --help'])('allows "%s"', (command) => {
    expect(guard(command)).toBeUndefined();
  });
});

describe('towerWorkspaceOwned', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tower-guard-owned-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports ownership while the state records a session', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ sessionId: 'session-main', roster: { agents: [] } }));
    expect(await towerWorkspaceOwned(file)).toBe(true);
  });

  it('reports no ownership once the session is released or the state is missing', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ roster: { agents: [] } }));
    expect(await towerWorkspaceOwned(file)).toBe(false);
    await writeFile(file, JSON.stringify({ sessionId: '' }));
    expect(await towerWorkspaceOwned(file)).toBe(false);
    expect(await towerWorkspaceOwned(join(dir, 'missing.json'))).toBe(false);
  });

  it('treats an unreadable state document as owned', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{"sessionId": "session-main"');
    expect(await towerWorkspaceOwned(file)).toBe(true);
    await writeFile(file, 'null');
    expect(await towerWorkspaceOwned(file)).toBe(true);
  });
});
