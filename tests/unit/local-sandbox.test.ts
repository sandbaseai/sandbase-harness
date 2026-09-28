/**
 * Unit tests for Local Sandbox Provider.
 * Validates: Requirements 12.1, 12.2, 12.5, Property 20
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LocalSandboxProvider, shellInvocationFor } from '@/sandbox/local-provider.js';

describe('Local Sandbox Provider', () => {
  it('falls back to cmd.exe when Windows has neither a configured shell nor Git Bash', () => {
    expect(shellInvocationFor('echo fallback', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, () => false)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'echo fallback'],
    });
  });

  let provider: LocalSandboxProvider;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-sandbox-'));
    provider = new LocalSandboxProvider(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('provision', () => {
    it('creates a working directory for the session', async () => {
      const sandbox = await provider.provision('sess_test', {
        name: 'local',
        sandbox_provider: 'local',
      });
      expect(sandbox.sessionId).toBe('sess_test');
      expect(existsSync(join(tmpDir, 'sandbox', 'sess_test'))).toBe(true);
    });
  });

  describe('execute', () => {
    it('runs a command and returns stdout', async () => {
      const sandbox = await provider.provision('sess_exec', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const result = await sandbox.execute('echo "hello world"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.timedOut).toBe(false);
    });

    it('returns stderr on error', async () => {
      const sandbox = await provider.provision('sess_err', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const result = await sandbox.execute('echo "error" >&2 && exit 1');
      expect(result.exitCode).toBe(1);
      expect(result.stderr.trim()).toBe('error');
    });

    it('does not inherit arbitrary service environment variables', async () => {
      process.env.MANAGED_AGENTS_TEST_SECRET = 'must-not-leak';
      try {
        const sandbox = await provider.provision('sess_env', {
          name: 'local',
          sandbox_provider: 'local',
        });
        const result = await sandbox.execute('printf %s "${MANAGED_AGENTS_TEST_SECRET:-}"');
        expect(result.stdout).toBe('');
      } finally {
        delete process.env.MANAGED_AGENTS_TEST_SECRET;
      }
    });

    it('passes explicitly supplied command environment variables', async () => {
      const sandbox = await provider.provision('sess_env_explicit', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const result = await sandbox.execute('printf %s "$INJECTED_VALUE"', {
        env: { INJECTED_VALUE: 'allowed' },
      });
      expect(result.stdout).toBe('allowed');
    });

    it('identifies SandBase child processes by default', async () => {
      const sandbox = await provider.provision('sess_env_identity', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const result = await sandbox.execute('printf %s "$AI_AGENT"');
      expect(result.stdout).toBe('sandbase-harness');
    });

    it('preserves an explicitly supplied nested agent identity', async () => {
      const sandbox = await provider.provision('sess_env_nested_identity', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const result = await sandbox.execute('printf %s "$AI_AGENT"', {
        env: { AI_AGENT: 'nested-agent' },
      });
      expect(result.stdout).toBe('nested-agent');
    });

    it('times out long-running commands (Property 20)', async () => {
      const sandbox = await provider.provision('sess_timeout', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const result = await sandbox.execute('sleep 10', { timeout: 100 });
      expect(result.timedOut).toBe(true);
    });

    it('returns once the shell exits even when a detached child holds the pipes', async () => {
      const sandbox = await provider.provision('sess_bg_pipe', {
        name: 'local',
        sandbox_provider: 'local',
      });
      // A detached grandchild can outlive the shell while holding the stdio
      // pipes; the exec must not wait for them (agents legitimately start
      // dev servers). On Windows Git Bash a plain "&" blocks the shell until
      // the job exits, so use the Win32-detached `start` there.
      const command = process.platform === 'win32'
        ? 'start /B sleep 15 > /dev/null 2>&1'
        : 'sleep 15 > /dev/null 2>&1 & echo launched';
      const started = Date.now();
      const result = await sandbox.execute(command);
      expect(result.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
      if (process.platform !== 'win32') {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('launched');
      }
    }, 20_000);

    it('rejects cwd paths that escape the sandbox workspace', async () => {
      const sandbox = await provider.provision('sess_exec_escape', {
        name: 'local',
        sandbox_provider: 'local',
      });

      await expect(sandbox.execute('pwd', { cwd: '..' })).rejects.toThrow(
        'Path escapes sandbox workspace',
      );
    });
  });

  describe('writeFile / readFile', () => {
    it('writes and reads a file', async () => {
      const sandbox = await provider.provision('sess_fs', {
        name: 'local',
        sandbox_provider: 'local',
      });
      await sandbox.writeFile('test.txt', 'hello');
      const content = await sandbox.readFile('test.txt');
      expect(content).toBe('hello');
    });

    it('creates nested directories', async () => {
      const sandbox = await provider.provision('sess_nested', {
        name: 'local',
        sandbox_provider: 'local',
      });
      await sandbox.writeFile('a/b/c.txt', 'deep');
      const content = await sandbox.readFile('a/b/c.txt');
      expect(content).toBe('deep');
    });

    it('rejects writes that escape the sandbox workspace', async () => {
      const sandbox = await provider.provision('sess_write_escape', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const outsidePath = join(tmpDir, 'escape.txt');

      await expect(sandbox.writeFile('../escape.txt', 'oops')).rejects.toThrow(
        'Path escapes sandbox workspace',
      );
      expect(existsSync(outsidePath)).toBe(false);
    });

    it('rejects reads that escape the sandbox workspace', async () => {
      const sandbox = await provider.provision('sess_read_escape', {
        name: 'local',
        sandbox_provider: 'local',
      });
      writeFileSync(join(tmpDir, 'secret.txt'), 'secret');

      await expect(sandbox.readFile('../secret.txt')).rejects.toThrow(
        'Path escapes sandbox workspace',
      );
    });

    it.skipIf(process.platform === 'win32')('rejects writes through symlinks that point outside the sandbox workspace', async () => {
      const sandbox = await provider.provision('sess_symlink_escape', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const workDir = join(tmpDir, 'sandbox', 'sess_symlink_escape');
      const outsidePath = join(tmpDir, 'outside.txt');
      writeFileSync(outsidePath, 'outside');
      symlinkSync(outsidePath, join(workDir, 'link.txt'));

      await expect(sandbox.writeFile('link.txt', 'oops')).rejects.toThrow(
        'Path escapes sandbox workspace',
      );
      expect(readFileSync(outsidePath, 'utf-8')).toBe('outside');
    });
  });

  describe('listFiles', () => {
    it('lists files recursively', async () => {
      const sandbox = await provider.provision('sess_list', {
        name: 'local',
        sandbox_provider: 'local',
      });
      await sandbox.writeFile('file1.txt', 'a');
      await sandbox.writeFile('dir/file2.txt', 'b');

      const files = await sandbox.listFiles('.');
      expect(files).toContain('file1.txt');
      expect(files).toContain('dir/file2.txt');
    });

    it('returns empty array for non-existent path', async () => {
      const sandbox = await provider.provision('sess_empty', {
        name: 'local',
        sandbox_provider: 'local',
      });
      const files = await sandbox.listFiles('nonexistent');
      expect(files).toEqual([]);
    });

    it('rejects list paths that escape the sandbox workspace', async () => {
      const sandbox = await provider.provision('sess_list_escape', {
        name: 'local',
        sandbox_provider: 'local',
      });

      await expect(sandbox.listFiles('..')).rejects.toThrow(
        'Path escapes sandbox workspace',
      );
    });
  });

  describe('canonical in-sandbox roots', () => {
    async function sandboxFor(sessionId: string) {
      return provider.provision(sessionId, { name: 'local', sandbox_provider: 'local' });
    }

    it('maps /workspace below the sandbox directory and reads it back', async () => {
      const sandbox = await sandboxFor('sess_canonical_workspace');
      await sandbox.writeFile('/workspace/widget/src/index.ts', 'export {};');

      const workDir = join(tmpDir, 'sandbox', 'sess_canonical_workspace');
      expect(readFileSync(join(workDir, 'workspace', 'widget', 'src', 'index.ts'), 'utf-8')).toBe('export {};');
      // The spelling the runtime publishes is the spelling that reads back.
      expect(await sandbox.readFile('/workspace/widget/src/index.ts')).toBe('export {};');
      // A listing stays relative to the sandbox root, which is what the sandbox
      // interface promises its callers.
      expect(await sandbox.listFiles('/workspace')).toEqual(['workspace/widget/src/index.ts']);
    });

    it('maps /mnt/session to its own directory rather than to the workspace root', async () => {
      const sandbox = await sandboxFor('sess_canonical_session');
      await sandbox.writeFile('/mnt/session/uploads/notes.txt', 'uploaded');
      await sandbox.writeFile('/workspace/notes.txt', 'checked out');

      const workDir = join(tmpDir, 'sandbox', 'sess_canonical_session');
      expect(readFileSync(join(workDir, 'mnt', 'session', 'uploads', 'notes.txt'), 'utf-8')).toBe('uploaded');
      expect(readFileSync(join(workDir, 'workspace', 'notes.txt'), 'utf-8')).toBe('checked out');
      expect(await sandbox.readFile('/mnt/session/uploads/notes.txt')).toBe('uploaded');
      expect(await sandbox.readFile('/workspace/notes.txt')).toBe('checked out');
    });

    it('runs a command in a canonical working directory', async () => {
      const sandbox = await sandboxFor('sess_canonical_cwd');
      await sandbox.writeFile('/workspace/project/marker.txt', 'here');

      const result = await sandbox.execute('node -p "process.cwd()"', { cwd: '/workspace/project' });
      expect(result.exitCode, result.stderr).toBe(0);
      // The working directory is *placed* inside the sandbox, but the command runs
      // as an ordinary host subprocess, so what it reports is the host path of the
      // mapped directory. That is why a command names files by their
      // sandbox-relative spelling — the case below — and why the canonical
      // spelling is for the file tools rather than for a command line.
      expect(resolve(result.stdout.trim())).toBe(
        join(tmpDir, 'sandbox', 'sess_canonical_cwd', 'workspace', 'project'),
      );
    });

    it('reads the same file from a command by its sandbox-relative spelling', async () => {
      const sandbox = await sandboxFor('sess_canonical_command_read');
      await sandbox.writeFile('/mnt/session/uploads/notes.txt', 'attached bytes');

      // The mapping is not applied to a command string, so the file is named the
      // way the shell sees it: relative to the working directory, which is the
      // sandbox directory by default.
      const result = await sandbox.execute(
        'node -p "require(\'fs\').readFileSync(\'mnt/session/uploads/notes.txt\',\'utf8\')"',
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain('attached bytes');
    });

    it('refuses absolute paths outside the canonical roots', async () => {
      const sandbox = await sandboxFor('sess_canonical_absolute');
      await expect(sandbox.readFile('/etc/passwd')).rejects.toThrow('Path escapes sandbox workspace');
      await expect(sandbox.writeFile('/tmp/escape.txt', 'oops')).rejects.toThrow('Path escapes sandbox workspace');
      await expect(sandbox.listFiles('/etc')).rejects.toThrow('Path escapes sandbox workspace');
    });

    it('refuses a name that only shares a prefix with a canonical root', async () => {
      const sandbox = await sandboxFor('sess_canonical_prefix');
      await expect(sandbox.readFile('/workspacex/file.txt')).rejects.toThrow('Path escapes sandbox workspace');
      await expect(sandbox.readFile('/mnt/sessionx/file.txt')).rejects.toThrow('Path escapes sandbox workspace');
      await expect(sandbox.readFile('/mnt/session-other/file.txt')).rejects.toThrow('Path escapes sandbox workspace');
    });

    it('refuses a traversal that leaves the sandbox through a canonical root', async () => {
      const sandbox = await sandboxFor('sess_canonical_traversal');
      await expect(sandbox.readFile('/mnt/session/../../outside.txt')).rejects.toThrow('Path escapes sandbox workspace');
      await expect(sandbox.readFile('/workspace/../../outside.txt')).rejects.toThrow('Path escapes sandbox workspace');
      await expect(sandbox.execute('pwd', { cwd: '/workspace/../..' })).rejects.toThrow('Path escapes sandbox workspace');

      // A `..` that stays inside the root it was spelled in is ordinary
      // normalization rather than an escape.
      await sandbox.writeFile('/mnt/session/notes.txt', 'inside');
      expect(await sandbox.readFile('/mnt/session/uploads/../notes.txt')).toBe('inside');
    });

    it('refuses a NUL byte in a canonical path', async () => {
      const sandbox = await sandboxFor('sess_canonical_nul');
      await expect(sandbox.readFile('/mnt/session/uploads/notes\u0000.txt')).rejects.toThrow('NUL');
      await expect(sandbox.writeFile('/workspace/notes\u0000.txt', 'oops')).rejects.toThrow('NUL');
    });

    it.skipIf(process.platform === 'win32')('refuses a canonical path that resolves through a symlink out of the sandbox', async () => {
      const sandbox = await sandboxFor('sess_canonical_symlink');
      const workDir = join(tmpDir, 'sandbox', 'sess_canonical_symlink');
      const outsidePath = join(tmpDir, 'outside-canonical.txt');
      writeFileSync(outsidePath, 'outside');
      mkdirSync(join(workDir, 'workspace'), { recursive: true });
      symlinkSync(outsidePath, join(workDir, 'workspace', 'link.txt'));

      await expect(sandbox.writeFile('/workspace/link.txt', 'oops')).rejects.toThrow('Path escapes sandbox workspace');
      expect(readFileSync(outsidePath, 'utf-8')).toBe('outside');
    });

    it.skipIf(process.platform !== 'win32')('refuses a Windows drive path', async () => {
      const sandbox = await sandboxFor('sess_canonical_drive');
      await expect(sandbox.readFile('C:\\Windows\\win.ini')).rejects.toThrow('Path escapes sandbox workspace');
    });
  });

  describe('cleanup', () => {
    it('removes the working directory', async () => {
      const sandbox = await provider.provision('sess_cleanup', {
        name: 'local',
        sandbox_provider: 'local',
      });
      await sandbox.writeFile('test.txt', 'data');
      await sandbox.cleanup();
      expect(existsSync(join(tmpDir, 'sandbox', 'sess_cleanup'))).toBe(false);
    });
  });
});
