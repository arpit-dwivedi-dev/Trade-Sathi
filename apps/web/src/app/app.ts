import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ThemeService } from './core/theme.service';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  // Instantiated at the root so the data-theme attribute is applied on every
  // route, including the ones with no other reason to inject it (auth, reset).
  private readonly theme = inject(ThemeService);
}
