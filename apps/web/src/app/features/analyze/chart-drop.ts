import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  PLATFORM_ID,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

export type SourceType = 'paste' | 'upload';

/**
 * The `userAgentData` entry point isn't in lib.dom's `Navigator` type yet
 * (it's Chromium-only), so it needs its own narrow shape rather than an
 * `any` cast.
 */
interface NavigatorWithUAData extends Navigator {
  readonly userAgentData?: { readonly mobile: boolean };
}

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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly disabled = input(false);
  readonly fileSelected = output<ChartFileSelection>();

  protected readonly acceptedTypes = ACCEPTED_TYPES;
  protected readonly dragging = signal(false);
  /**
   * Why a selection was refused, or null. Rejections used to be silent, so
   * dropping a PDF — or a screenshot the OS handed over as a format the browser
   * cannot decode — looked exactly like the app having ignored the gesture.
   */
  protected readonly notice = signal<string | null>(null);

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  /**
   * "Take a photo" only makes sense on a device that actually has a camera a
   * trader would point at a chart on a monitor — a laptop's webcam faces the
   * user, not the screen they're photographing, so the button is hidden
   * there and desktop keeps just the file picker.
   */
  protected readonly isMobileDevice = signal(false);

  /**
   * A live `getUserMedia` view rather than `<input capture>`: the `capture`
   * attribute is only a hint, and desktop browsers ignore it and fall back to
   * the plain file picker anyway.
   */
  protected readonly cameraOpen = signal(false);
  protected readonly cameraError = signal<string | null>(null);
  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoEl');
  private readonly cameraOverlay = viewChild<ElementRef<HTMLElement>>('cameraOverlay');
  private readonly canvasEl = viewChild.required<ElementRef<HTMLCanvasElement>>('canvasEl');
  private cameraStream: MediaStream | null = null;

  /**
   * dragenter/dragleave fire for every child element the pointer crosses, so a
   * single boolean flickered off the moment the cursor moved over the icon or
   * the caption inside the zone. Counting entries against leaves tracks the
   * zone as a whole.
   */
  private dragDepth = 0;

  private readonly onDocumentPaste = (event: ClipboardEvent): void => {
    if (this.disabled() || !this.isVisible()) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;

      // Only the first file item is used; anything after it is ignored.
      event.preventDefault();
      this.offer(file, 'paste');
      return;
    }
    // No file in the clipboard (e.g. pasted text): silent no-op by design.
  };

  /**
   * Whether this component is actually on screen.
   *
   * The paste listener is on the document, because pasting must work without
   * clicking into anything first — but the analyze page stays mounted and
   * merely hidden while the user is on another tab. Without this check, a
   * Ctrl+V anywhere in the app started an upload on an invisible tab and spent
   * an analysis the user never saw.
   */
  private isVisible(): boolean {
    return this.host.nativeElement.getClientRects().length > 0;
  }

  /**
   * Validates one candidate file and emits it, or explains why not. Every
   * input path (paste, drop, file picker) goes through here so they cannot
   * disagree about what is acceptable.
   */
  private offer(file: File, sourceType: SourceType): void {
    if (!ACCEPTED_TYPES.split(',').includes(file.type)) {
      this.notice.set(
        file.type.startsWith('image/')
          ? 'That image format is not supported. Use a PNG, JPG or WEBP screenshot.'
          : 'That is not an image. Paste or drop a chart screenshot instead.',
      );
      return;
    }

    this.notice.set(null);
    this.fileSelected.emit({ file, sourceType });
  }

  constructor() {
    // Document listeners only exist in the browser; during SSR there is no
    // document to attach to.
    if (isPlatformBrowser(this.platformId)) {
      document.addEventListener('paste', this.onDocumentPaste);
      this.isMobileDevice.set(this.detectMobileDevice());
    }
  }

  private detectMobileDevice(): boolean {
    const uaData = (navigator as NavigatorWithUAData).userAgentData;
    if (uaData) return uaData.mobile;
    // Fallback for browsers without the Client Hints API (Firefox, Safari).
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  ngOnDestroy(): void {
    if (isPlatformBrowser(this.platformId)) {
      document.removeEventListener('paste', this.onDocumentPaste);
    }
    this.stopCameraStream();
  }

  protected onDragEnter(event: DragEvent): void {
    event.preventDefault();
    if (this.disabled()) return;
    this.dragDepth += 1;
    this.dragging.set(true);
  }

  protected onDragOver(event: DragEvent): void {
    // Without preventDefault the browser navigates to the dropped file instead
    // of firing a drop event on this element.
    event.preventDefault();
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = 0;
    this.dragging.set(false);
    if (this.disabled()) return;

    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    // Drag-drop is bucketed as 'upload': the backend's source_type enum has no
    // third value, and drop is a fallback path rather than the paste flow.
    this.offer(file, 'upload');
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset so picking the same file twice in a row still fires a change event.
    input.value = '';

    if (this.disabled() || !file) return;
    this.offer(file, 'upload');
  }

  protected browse(): void {
    if (this.disabled()) return;
    this.fileInput().nativeElement.click();
  }

  /**
   * Requests camera access and, once granted, opens the live preview.
   * Prefers the rear camera on a phone; a laptop only has the one webcam so
   * `facingMode` there is just ignored.
   */
  protected async openCamera(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.disabled() || !this.isMobileDevice()) return;

    if (!isPlatformBrowser(this.platformId) || !navigator.mediaDevices?.getUserMedia) {
      this.cameraError.set('Camera capture is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.cameraStream = stream;
      this.cameraError.set(null);
      this.cameraOpen.set(true);

      // The <video> only exists once cameraOpen() flips the @if in the
      // template, so the stream can't be attached until after that render.
      afterNextRender(
        () => {
          const video = this.videoEl()?.nativeElement;
          if (!video) return;
          video.srcObject = stream;
          void video.play();
          this.cameraOverlay()?.nativeElement.focus();
        },
        { injector: this.injector },
      );
    } catch {
      this.cameraError.set('Camera access was denied or no camera is available.');
    }
  }

  /** Grabs the current video frame and offers it like any other file. */
  protected capturePhoto(): void {
    const video = this.videoEl()?.nativeElement;
    const canvas = this.canvasEl().nativeElement;
    if (!video || !video.videoWidth) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `chart-camera-${Date.now()}.png`, { type: 'image/png' });
      this.closeCamera();
      // Bucketed as 'upload' for the same reason a drag-drop is: the
      // backend's source_type enum has no third value for a camera capture.
      this.offer(file, 'upload');
    }, 'image/png');
  }

  protected closeCamera(): void {
    this.stopCameraStream();
    this.cameraOpen.set(false);
  }

  private stopCameraStream(): void {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
  }

  /** Space/Enter on the zone opens the picker, as a real button would. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.browse();
  }
}
