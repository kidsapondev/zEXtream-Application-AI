import { ArtifactStreamParser } from './artifact-stream-parser';

describe('ArtifactStreamParser', () => {
  it('closes an empty artifact when the stream ends after the opening fence', () => {
    const parser = new ArtifactStreamParser();

    const segments = parser.push('```typescript:src/app.ts\n');
    const flushed = parser.flush();

    expect(segments).toEqual([
      {
        type: 'artifact-start',
        language: 'typescript',
        filename: 'src/app.ts',
      },
    ]);
    expect(flushed).toEqual([{ type: 'artifact-end' }]);
  });

  it('turns an unterminated code block into a complete artifact at EOF', () => {
    const parser = new ArtifactStreamParser();

    const segments = parser.push('```js:main.js\nconsole.log("ok");');

    expect([...segments, ...parser.flush()]).toEqual([
      { type: 'artifact-start', language: 'js', filename: 'main.js' },
      { type: 'artifact-chunk', text: 'console.log("ok");' },
      { type: 'artifact-end' },
    ]);
  });

  it('does not emit duplicate closing segments when flushed twice', () => {
    const parser = new ArtifactStreamParser();

    const segments = parser.push('```text:file.txt\ncontent');

    expect([...segments, ...parser.flush()]).toEqual([
      { type: 'artifact-start', language: 'text', filename: 'file.txt' },
      { type: 'artifact-chunk', text: 'content' },
      { type: 'artifact-end' },
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it('recognizes a closing fence at EOF without a trailing newline', () => {
    const parser = new ArtifactStreamParser();
    const segments = parser.push('```text:file.txt\ncontent\n```');

    expect([...segments, ...parser.flush()]).toEqual([
      { type: 'artifact-start', language: 'text', filename: 'file.txt' },
      { type: 'artifact-chunk', text: 'content\n' },
      { type: 'artifact-end' },
    ]);
  });

  it('recognizes an opening fence split after the initial backticks', () => {
    const parser = new ArtifactStreamParser();

    expect(parser.push('```')).toEqual([]);
    expect([
      ...parser.push(
        'typescript:src/example.ts\nexport const value = 1;\n```\n',
      ),
      ...parser.flush(),
    ]).toEqual([
      {
        type: 'artifact-start',
        language: 'typescript',
        filename: 'src/example.ts',
      },
      { type: 'artifact-chunk', text: 'export const value = 1;\n' },
      { type: 'artifact-end' },
    ]);
  });

  it('keeps a token-split fence header until its newline arrives', () => {
    const parser = new ArtifactStreamParser();
    const chunks = [
      '```',
      'typescript',
      ':',
      'src/',
      'artifact.ts',
      '\n',
      'export {}\n',
      '```\n',
    ];
    const segments = chunks.flatMap((chunk) => parser.push(chunk));

    expect([...segments, ...parser.flush()]).toEqual([
      {
        type: 'artifact-start',
        language: 'typescript',
        filename: 'src/artifact.ts',
      },
      { type: 'artifact-chunk', text: 'export {}' },
      { type: 'artifact-chunk', text: '\n' },
      { type: 'artifact-end' },
    ]);
  });
});
