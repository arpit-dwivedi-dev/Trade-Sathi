import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LegalShell } from './legal-shell';

@Component({
  selector: 'app-privacy-page',
  imports: [LegalShell, RouterLink],
  styleUrl: './legal-prose.css',
  templateUrl: './privacy-page.html',
})
export class PrivacyPage {}
