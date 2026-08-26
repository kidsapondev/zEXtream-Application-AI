import { fileIconLabelFor, fileKindFor, monacoLanguageFor } from './file-kinds';

describe('file kinds', () => {
  it('colours the mockup file types by extension, case-insensitively and through a path', () => {
    expect(fileKindFor('index.php')).toBe('php');
    expect(fileKindFor('app.js')).toBe('js');
    expect(fileKindFor('main.PY')).toBe('py');
    expect(fileKindFor('styles/theme.css')).toBe('css');
    expect(fileKindFor('public/index.html')).toBe('html');
    expect(fileKindFor('package.json')).toBe('json');
  });

  it('falls back to a neutral badge and plaintext rather than guessing', () => {
    expect(fileKindFor('LICENSE')).toBe('default');
    expect(fileIconLabelFor('LICENSE')).toBe('•');
    expect(monacoLanguageFor('LICENSE')).toBe('plaintext');
  });

  it('reads a dotfile by its whole name, not as an extension', () => {
    // `.gitignore` would otherwise resolve as an extension of "gitignore" and miss.
    expect(fileIconLabelFor('.gitignore')).toBe('git');
    expect(monacoLanguageFor('.env')).toBe('ini');
    expect(monacoLanguageFor('.env.production')).toBe('ini');
  });

  it('maps extensions that share a badge onto their own Monaco languages', () => {
    expect(fileKindFor('theme.scss')).toBe('css');
    expect(monacoLanguageFor('theme.scss')).toBe('scss');
    expect(monacoLanguageFor('theme.css')).toBe('css');
  });
});
