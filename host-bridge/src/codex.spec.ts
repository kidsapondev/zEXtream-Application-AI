import { Request, Response } from 'express';
import { runProcess } from './process-runner';
import { codexChat, codexStatus } from './codex';

jest.mock('./process-runner');
jest.mock('./config', () => ({
  config: {
    claudeExePath: 'claude.exe',
    codexExePath: 'codex.exe',
    neutralCwd: '/tmp',
    chatTimeoutMs: 1000,
    bridgeToken: 'test-token',
    port: 0,
  },
}));

const mockRunProcess = runProcess as jest.MockedFunction<typeof runProcess>;

function mockRes() {
  const res: Partial<Response> = {
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe('codexStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports available when login status output contains "Logged in" on stdout with exit code 0', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: 'Logged in using ChatGPT',
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await codexStatus({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ available: true });
  });

  it('reports available when "Logged in" is on stderr instead of stdout (confirmed real behavior when spawned non-interactively)', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: '',
      stderr: 'Logged in using ChatGPT',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await codexStatus({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ available: true });
  });

  it('reports unavailable when not logged in', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: 'Not logged in',
      stderr: '',
      code: 1,
      timedOut: false,
    });
    const res = mockRes();

    await codexStatus({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ available: false });
  });
});

describe('codexChat', () => {
  beforeEach(() => jest.clearAllMocks());

  it('parses the agent_message text and turn.completed usage from NDJSON events', async () => {
    const lines = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'PONG' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 6, reasoning_output_tokens: 4 },
      },
    ];
    mockRunProcess.mockResolvedValue({
      stdout: lines.map((l) => JSON.stringify(l)).join('\n'),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await codexChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    expect(res.write).toHaveBeenNthCalledWith(
      1,
      `${JSON.stringify({ type: 'token', delta: 'PONG' })}\n`,
    );
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 10 },
      })}\n`,
    );
  });

  it('emits an error event when a turn.failed event is present', async () => {
    const lines = [
      { type: 'turn.failed', error: { message: 'upstream unavailable' } },
    ];
    mockRunProcess.mockResolvedValue({
      stdout: lines.map((l) => JSON.stringify(l)).join('\n'),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await codexChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    expect(res.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'error', message: 'upstream unavailable' })}\n`,
    );
  });

  it('emits an error event when the process times out', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: '',
      stderr: '',
      code: null,
      timedOut: true,
    });
    const res = mockRes();

    await codexChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    expect(res.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'error', message: 'codex CLI timed out' })}\n`,
    );
  });

  it('emits an error event when no agent_message text is produced', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: JSON.stringify({ type: 'turn.completed', usage: {} }),
      stderr: 'nothing came out',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await codexChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    const written = (res.write as jest.Mock).mock.calls[0][0] as string;
    expect(JSON.parse(written).type).toBe('error');
  });
});
