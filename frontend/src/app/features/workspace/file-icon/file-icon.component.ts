import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { fileIconLabelFor, fileKindFor } from './file-kinds';

/**
 * The coloured, rounded badge that stands in for a file's type in the explorer, the tab
 * strip and the breadcrumb.
 *
 * Text-in-a-swatch rather than a real icon set on purpose: a full icon font (Seti, Material
 * Icon Theme) is hundreds of kilobytes of glyphs for a workspace whose files are mostly
 * half a dozen languages, and at the 20px this renders at, a two-letter label is *more*
 * legible than a shrunken logo. It also degrades honestly — an unrecognised extension gets a
 * neutral badge instead of a wrong logo.
 */
@Component({
  selector: 'app-file-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="file-icon" [class]="'file-icon--' + kind()" aria-hidden="true">{{ label() }}</span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex: none;
      }

      .file-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 6px;
        font-family: var(--font-mono);
        font-size: 9px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: -0.02em;
        color: var(--ws-icon-ink);
        background: var(--ws-icon-default);
        user-select: none;
      }

      .file-icon--php {
        background: var(--ws-icon-php);
      }
      .file-icon--js {
        background: var(--ws-icon-js);
      }
      .file-icon--ts {
        background: var(--ws-icon-ts);
      }
      .file-icon--py {
        background: var(--ws-icon-py);
      }
      .file-icon--css {
        background: var(--ws-icon-css);
      }
      .file-icon--html {
        background: var(--ws-icon-html);
      }
      .file-icon--json {
        background: var(--ws-icon-json);
      }
      .file-icon--md {
        background: var(--ws-icon-md);
      }
      .file-icon--img {
        background: var(--ws-icon-img);
      }

      /* The neutral badge is the only one dark enough to swallow near-black ink. */
      .file-icon--default {
        color: var(--ws-text-secondary);
      }
    `,
  ],
})
export class FileIconComponent {
  /** File name or path — only the basename is inspected. */
  readonly name = input.required<string>();

  protected readonly kind = computed(() => fileKindFor(this.name()));
  protected readonly label = computed(() => fileIconLabelFor(this.name()));
}
