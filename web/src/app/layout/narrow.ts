import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HeaderService } from '../core/header.service';

/** Sign-in screens and "Your teams": one centered card. */
@Component({
  selector: 'th-narrow',
  imports: [RouterOutlet],
  template: `<main class="narrow"><section class="card pad"><router-outlet /></section></main>`
})
export class Narrow {
  constructor() { inject(HeaderService).reset(); }
}
