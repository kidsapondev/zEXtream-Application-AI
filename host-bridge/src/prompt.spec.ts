import { buildPrompt } from './prompt';

describe('buildPrompt', () => {
  it('flattens user/assistant turns into a Human/Assistant transcript', () => {
    const { promptText } = buildPrompt([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]);

    expect(promptText).toBe(
      'Human: hi\n\nAssistant: hello\n\nHuman: how are you',
    );
  });

  it('excludes system messages from the transcript and folds them into systemPrompt', () => {
    const { promptText, systemPrompt } = buildPrompt([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(promptText).toBe('Human: hi');
    expect(systemPrompt).toContain('Be concise.');
  });

  it('always includes the no-tools safety preamble in systemPrompt', () => {
    const { systemPrompt } = buildPrompt([{ role: 'user', content: 'hi' }]);

    expect(systemPrompt).toMatch(/no tools/i);
  });
});
