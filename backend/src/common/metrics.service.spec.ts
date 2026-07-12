import { MetricsService } from './metrics.service';

describe('MetricsService — AI stream metrics', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  async function metricNamed(name: string): Promise<string> {
    const all = await metrics.registry.metrics();
    return all
      .split('\n')
      .filter((line) => line.startsWith(name))
      .join('\n');
  }

  it('increments the active-streams gauge on streamStarted and decrements on streamEnded', async () => {
    metrics.streamStarted('ollama');
    metrics.streamStarted('ollama');
    expect(await metricNamed('ai_active_streams')).toContain(
      'ai_active_streams{provider="ollama"} 2',
    );

    metrics.streamEnded('ollama', 'complete', 1.5);
    expect(await metricNamed('ai_active_streams')).toContain(
      'ai_active_streams{provider="ollama"} 1',
    );
  });

  it('tracks active streams independently per provider', async () => {
    metrics.streamStarted('ollama');
    metrics.streamStarted('claude');
    const output = await metricNamed('ai_active_streams');
    expect(output).toContain('ai_active_streams{provider="ollama"} 1');
    expect(output).toContain('ai_active_streams{provider="claude"} 1');
  });

  it('records stream duration labeled by provider and final status', async () => {
    metrics.streamStarted('openai');
    metrics.streamEnded('openai', 'error', 3.2);

    const output = await metricNamed('ai_stream_duration_seconds');
    expect(output).toContain(
      'ai_stream_duration_seconds_count{provider="openai",status="error"} 1',
    );
  });

  it('records first-token latency labeled by provider', async () => {
    metrics.observeFirstTokenLatency('ollama', 0.42);

    const output = await metricNamed('ai_first_token_latency_seconds');
    expect(output).toContain(
      'ai_first_token_latency_seconds_count{provider="ollama"} 1',
    );
  });
});
