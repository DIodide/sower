import { describe, expect, it } from 'vitest';
import { exec } from './exec.js';

describe('exec', () => {
  it('resolves stdout on success', async () => {
    const { stdout } = await exec(process.execPath, [
      '-e',
      'process.stdout.write("ok")',
    ]);
    expect(stdout).toBe('ok');
  });

  it('throws on a non-zero exit with stderr in the message', async () => {
    await expect(
      exec(process.execPath, [
        '-e',
        'process.stderr.write("boom"); process.exit(3)',
      ]),
    ).rejects.toThrow(/boom/);
  });

  it('redacts secrets from BOTH the rendered command line and the output', async () => {
    const token = 'ghp_supersecret42';
    const error = await exec(
      process.execPath,
      [
        '-e',
        `process.stderr.write("auth failed for ${token}");process.exit(1)`,
      ],
      { secrets: [token] },
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The token appeared in argv AND stderr; neither may survive.
    expect(message).not.toContain(token);
    expect(message).toContain('[redacted]');
  });

  it('scrubs tokenized URLs from failures even without a listed secret', async () => {
    const error = await exec(process.execPath, [
      '-e',
      'process.stderr.write("fatal: https://x-access-token:tok123@github.com/r.git");process.exit(1)',
    ]).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('tok123');
  });

  it('kills a command that exceeds the timeout', async () => {
    await expect(
      exec(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/failed/);
  }, 10_000);
});
