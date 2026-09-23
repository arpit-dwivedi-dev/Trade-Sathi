import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LegalShell } from './legal-shell';

@Component({
  selector: 'app-terms-page',
  imports: [LegalShell, RouterLink],
  styleUrl: './legal-prose.css',
  templateUrl: './terms-page.html',
})
export class TermsPage {}
