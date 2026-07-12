import { Injectable } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const [
      totalUsers,
      activeUsers,
      adminCount,
      pendingGuestCount,
      totalSessions,
      totalMessages,
      providerCredentialGroups,
      tokenUsageTotal,
      tokenUsageByProvider,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { role: 'admin' } }),
      this.prisma.user.count({ where: { role: 'guest' } }),
      this.prisma.chatSession.count(),
      this.prisma.message.count(),
      this.prisma.providerCredential.groupBy({
        by: ['provider'],
        _count: { _all: true },
      }),
      this.prisma.message.aggregate({ _sum: { tokenCount: true } }),
      // `provider` is only ever set on assistant messages (user messages leave it
      // null), so this naturally excludes them without an explicit filter.
      this.prisma.message.groupBy({
        by: ['provider'],
        where: { provider: { not: null } },
        _sum: { tokenCount: true },
      }),
    ]);

    const providerConfiguredCounts: Record<AiProvider, number> = {
      ollama: 0,
      claude: 0,
      openai: 0,
    };
    for (const group of providerCredentialGroups) {
      providerConfiguredCounts[group.provider] = group._count._all;
    }

    const tokensByProvider: Record<AiProvider, number> = {
      ollama: 0,
      claude: 0,
      openai: 0,
    };
    for (const group of tokenUsageByProvider) {
      if (group.provider) {
        tokensByProvider[group.provider] = group._sum.tokenCount ?? 0;
      }
    }

    return {
      totalUsers,
      activeUsers,
      inactiveUsers: totalUsers - activeUsers,
      adminCount,
      pendingGuestCount,
      totalSessions,
      totalMessages,
      providerConfiguredCounts,
      totalTokensUsed: tokenUsageTotal._sum.tokenCount ?? 0,
      tokensByProvider,
    };
  }
}
