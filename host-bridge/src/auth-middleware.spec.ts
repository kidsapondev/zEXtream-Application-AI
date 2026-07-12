import { Request, Response } from 'express';
import { requireBridgeToken } from './auth-middleware';

function mockRes() {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe('requireBridgeToken', () => {
  const middleware = requireBridgeToken('correct-token');

  it('calls next() when the token matches', () => {
    const req = { header: () => 'correct-token' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the token is wrong', () => {
    const req = { header: () => 'wrong-token' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects with 401 when the token header is missing', () => {
    const req = { header: () => undefined } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a token of a different length without throwing', () => {
    const req = { header: () => 'short' } as unknown as Request;
    const res = mockRes();
    const next = jest.fn();

    expect(() => middleware(req, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
  });
});
