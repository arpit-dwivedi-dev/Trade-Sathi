import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  PLATFORM_ID,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

export type SourceType = 'paste' | 'upload';

export interface ChartFileSelection {
  file: File;
  sourceType: SourceType;
}

/** Accepted upstream by POST /api/analyses; also the file picker's `accept`. */
const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp';

/**
 * Input-capture surface for a chart screenshot. Presentational: it detects an
 * image from a paste, a drop or the file picker and emits it. It knows nothing
 * about compression, the API or analysis state.
 *
 * Paste is the primary path — a trader takes an OS screenshot, switches tab and
 * hits Ctrl+V — so the listener is on the *document*, not this element: pasting
 * must work without clicking into anything first.
 */
@Component({
  selector: 'app-chart-drop',
  templateUrl: './chart-drop.html',
  styleUrl: './chart-drop.css',
})
export class ChartDrop implements OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);

  readonly disabled = input(false);
  readonly fileSelected = output<ChartFileSelection>();

  protected readonly acceptedTypes = ACCEPTED_TYPES;
  protected readonly dragging = signal(false);

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  private readonly onDocumentPaste = (event: ClipboardEvent): void => {
    if (this.disabled()) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;

      // Only the first image item is used; anything after it is ignored.
      event.preventDefault();
      this.fileSelected.emit({ file, sourceType: 'paste' });
      return;
    }
    // No image in the clipboard (e.g. pasted text): silent no-op by design.
  };

  constructor() {
    // Document listeners only exist in the browser; during SSR there is no
    // document to attach to.
    if (isPlatformBrowser(this.platformId)) {
      document.addEventListener('paste', this.onDocumentPaste);
    }
  }

  ngOnDestroy(): void {
    if (isPlatformBrowser(this.platformId)) {
      document.removeEventListener('paste', this.onDocumentPaste);
    }
  }

  protected onDragOver(event: DragEvent): void {
    // Without preventDefault the browser navigates to the dropped file instead
    // of firing a drop event on this element.
    event.preventDefault();
    if (this.disabled()) return;
    this.dragging.set(true);
  }

  protected onDragLeave(): void {
    this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    if (this.disabled()) return;

    const file = this.firstImage(event.dataTransfer?.files);
    // Drag-drop is bucketed as 'upload': the backend's source_type enum has no
    // third value, and drop is a fallback path rather than the paste flow.
    if (file) this.fileSelected.emit({ file, sourceType: 'upload' });
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = this.firstImage(input.files);
    // Reset so picking the same file twice in a row still fires a change event.
    input.value = '';

    if (this.disabled() || !file) return;
    this.fileSelected.emit({ file, sourceType: 'upload' });
  }

  protected browse(): void {
    if (this.disabled()) return;
    this.fileInput().nativeElement.click();
  }

  /** First image-typed file, or null. Non-image entries are ignored silently. */
  private firstImage(files: FileList | null | undefined): File | null {
    if (!files) return null;
    return Array.from(files).find((f) => f.type.startsWith('image/')) ?? null;
  }
}
