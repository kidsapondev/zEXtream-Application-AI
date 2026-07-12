import { AdminDashboardService } from './admin-dashboard.service';

describe('AdminDashboardService', () => {
  const prisma = {
    user: { count: jest.fn() },
    chatSession: { count: jest.fn() },
    message: { count: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
    providerCredential: { groupBy: jest.fn() },
  };
  const service = new AdminDashboardService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.count.mockResolvedValue(0);
    prisma.chatSession.count.mockResolvedValue(0);
    prisma.message.count.mockResolvedValue(0);
    prisma.providerCredential.groupBy.mockResolvedValue([]);
    prisma.message.aggregate.mockResolvedValue({ _sum: { tokenCount: null } });
    prisma.message.groupBy.mockResolvedValue([]);
  });

  it('sums tokenCount across every message into totalTokensUsed', async () => {
    prisma.message.aggregate.mockResolvedValue({ _sum: { tokenCount: 150 } });

    const stats = await service.getStats();

    expect(prisma.message.aggregate).toHaveBeenCalledWith({
      _sum: { tokenCount: true },
    });
    expect(stats.totalTokensUsed).toBe(150);
  });

  it('defaults totalTokensUsed to 0 when no message has reported usage yet', async () => {
    const stats = await service.getStats();

    expect(stats.totalTokensUsed).toBe(0);
  });

  it('builds tokensByProvider from the per-provider groupBy, excluding user messages via the null-provider filter', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { provider: 'ollama', _sum: { tokenCount: 100 } },
      { provider: 'claude', _sum: { tokenCount: 50 } },
    ]);

    const stats = await service.getStats();

    expect(prisma.message.groupBy).toHaveBeenCalledWith({
      by: ['provider'],
      where: { provider: { not: null } },
      _sum: { tokenCount: true },
    });
    expect(stats.tokensByProvider).toEqual({
      ollama: 100,
      claude: 50,
      openai: 0,
    });
  });

  it('defaults a provider with no groupBy entry to 0 tokens', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { provider: 'ollama', _sum: { tokenCount: 100 } },
    ]);

    const stats = await service.getStats();

    expect(stats.tokensByProvider).toEqual({
      ollama: 100,
      claude: 0,
      openai: 0,
    });
  });
});
