import { Component, computed, input } from '@angular/core';

import { ICON_VIEW_BOX, MATERIAL_SYMBOL_PATHS, type IconName } from './icon-paths';

/**
 * Draws one glyph from MATERIAL_SYMBOL_PATHS as an inline SVG.
 *
 * Replaces `<mat-icon svgIcon="...">` now that Angular Material (and its
 * MatIconRegistry) is gone — the outline data itself didn't need to move,
 * only how a template asks for it: `<app-icon name="close" />`. Binding
 * [attr.d] to a string from this file's own literal map needs no
 * DomSanitizer.bypassSecurityTrustHtml the way the registry version did,
 * since nothing here is treated as HTML.
 */
@Component({
  selector: 'app-icon',
  template: `
    <svg [attr.viewBox]="viewBox" fill="currentColor" aria-hidden="true">
      <path [attr.d]="path()" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    svg {
      display: block;
      width: 1em;
      height: 1em;
    }
  `,
})
export class AppIcon {
  readonly name = input.required<IconName>();
  protected readonly viewBox = ICON_VIEW_BOX;
  protected readonly path = computed(() => MATERIAL_SYMBOL_PATHS[this.name()]);
}
