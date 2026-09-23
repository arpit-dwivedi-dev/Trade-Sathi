import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LegalShell } from './legal-shell';

@Component({
  selector: 'app-contact-page',
  imports: [LegalShell, RouterLink],
  styleUrl: './legal-prose.css',
  templateUrl: './contact-page.html',
})
export class ContactPage {}
