import { Component, computed, input } from '@angular/core';
import { mapLinks, mapQuery } from '../core/maps';

/**
 * A place you can open in a map app. Shows "Venue · 123 Main St", with the address (or, with no address yet,
 * the venue) linked to Apple Maps on Apple devices and Google Maps elsewhere. ▾ offers the other app.
 */
@Component({
  selector: 'th-map-link',
  template: `
    @if (query()) {
      <span class="maplink">
        @if (showPlace()) { <span>{{ place() }}</span><span class="ml-sep" aria-hidden="true"> · </span> }
        <a class="ml-a" [href]="links().primary.url" target="_blank" rel="noopener" [attr.aria-label]="text() + ', open in ' + links().primary.name">{{ text() }}</a>
        <details class="map-more">
          <summary [attr.aria-label]="'More map apps for ' + text()" title="Open in another map app"><span aria-hidden="true">▾</span></summary>
          <div class="edit-pop" role="group" aria-label="Map apps">
            <a [href]="links().primary.url" target="_blank" rel="noopener">Open in {{ links().primary.name }}</a>
            <a [href]="links().other.url" target="_blank" rel="noopener">Open in {{ links().other.name }}</a>
          </div>
        </details>
      </span>
    } @else if (place()) {
      <span>{{ place() }}</span>
    }`
})
export class MapLink {
  /** Street address, when someone entered one. */
  readonly address = input<string | null | undefined>('');
  /** Venue or place name ("A5 Sportsplex"). */
  readonly place = input<string | null | undefined>('');
  /** City, used with the place name when there's no address. */
  readonly city = input<string | null | undefined>('');

  readonly query = computed(() => mapQuery(this.address(), this.place(), this.city()));
  readonly links = computed(() => mapLinks(this.query()));
  /** With an address, the place name is shown as plain text before it. */
  readonly showPlace = computed(() => !!(this.address()?.trim() && this.place()?.trim()));
  readonly text = computed(() => this.address()?.trim() || this.place()?.trim() || this.city()?.trim() || '');
}
