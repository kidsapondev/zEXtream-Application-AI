import { Request, Response } from 'express';
import { runProcess } from './process-runner';
import { claudeChat, claudeStatus } from './claude';

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

describe('claudeStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports available when auth status is logged in with exit code 0', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await claudeStatus({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ available: true });
  });

  it('reports unavailable when not logged in', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await claudeStatus({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ available: false });
  });

  it('reports unavailable when output is not parseable JSON', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: 'not json',
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await claudeStatus({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ available: false });
  });
});

describe('claudeChat', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits a token event with the result text then a done event with combined usage', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: JSON.stringify({
        is_error: false,
        result: 'Hi there!',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 5,
        },
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await claudeChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    expect(res.write).toHaveBeenNthCalledWith(
      1,
      `${JSON.stringify({ type: 'token', delta: 'Hi there!' })}\n`,
    );
    expect(res.write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 60, outputTokens: 5 },
      })}\n`,
    );
    expect(res.end).toHaveBeenCalled();
  });

  it('emits an error event when the CLI reports is_error', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const res = mockRes();

    await claudeChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    expect(res.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'error', message: 'Not logged in' })}\n`,
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

    await claudeChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    expect(res.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: 'error', message: 'claude CLI timed out' })}\n`,
    );
  });

  it('emits an error event when stdout is not parseable JSON', async () => {
    mockRunProcess.mockResolvedValue({
      stdout: 'garbage',
      stderr: 'boom',
      code: 1,
      timedOut: false,
    });
    const res = mockRes();

    await claudeChat(
      { body: { messages: [{ role: 'user', content: 'hi' }] } } as Request,
      res,
    );

    const written = (res.write as jest.Mock).mock.calls[0][0] as string;
    expect(JSON.parse(written).type).toBe('error');
  });
});
