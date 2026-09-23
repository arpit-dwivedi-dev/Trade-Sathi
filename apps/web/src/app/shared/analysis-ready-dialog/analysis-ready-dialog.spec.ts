import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { AnalysisReadyDialog, type ReadyAnalysis } from './analysis-ready-dialog';

@Component({
  imports: [AnalysisReadyDialog],
  template: `
    <app-analysis-ready-dialog
      [ready]="ready()"
      (view)="viewed = viewed + 1"
      (dismissed)="dismissed = dismissed + 1"
    />
  `,
})
class Host {
  readonly ready = signal<ReadyAnalysis>({ id: 'a1', symbol: 'TCS', kind: 'chart' });
  viewed = 0;
  dismissed = 0;
}

function render() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  return { fixture, host: fixture.componentInstance, el, button };
}

describe('AnalysisReadyDialog', () => {
  it('names the symbol and the kind of analysis', () => {
    const { fixture, host, el } = render();
    expect(el.textContent).toContain('chart analysis for');
    expect(el.textContent).toContain('TCS');

    host.ready.set({ id: 'a2', symbol: 'INFY', kind: 'fundamentals' });
    fixture.detectChanges();
    expect(el.textContent).toContain('fundamentals analysis for');
    expect(el.textContent).toContain('INFY');
  });

  it('emits view from View', () => {
    const { host, button } = render();
    button('View').click();
    expect(host.viewed).toBe(1);
    expect(host.dismissed).toBe(0);
  });

  it('emits dismissed from Later, Escape and a click on the overlay', () => {
    const { host, el, button } = render();
    button('Later').click();
    el.querySelector('[role="dialog"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    el.querySelector<HTMLElement>('.ard-overlay')!.click();
    expect(host.dismissed).toBe(3);
    expect(host.viewed).toBe(0);
  });

  it('stays open on a click inside the dialog', () => {
    const { host, el } = render();
    el.querySelector<HTMLElement>('[role="dialog"]')!.click();
    expect(host.dismissed).toBe(0);
  });

  it('focuses View, so Enter opens the report', async () => {
    const { fixture, button } = render();
    await fixture.whenStable();
    expect(document.activeElement).toBe(button('View'));
  });
});
