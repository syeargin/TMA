import { Component, input } from '@angular/core';

@Component({
  selector: 'th-messages',
  template: `
    @if (error()) { <p class="msg error" role="alert">{{ error() }}</p> }
    @if (notice()) { <p class="msg notice" role="status">{{ notice() }}</p> }`
})
export class Messages {
  readonly error = input('');
  readonly notice = input('');
}
