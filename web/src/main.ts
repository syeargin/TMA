import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { APP_CONFIG, loadConfig } from './app/core/config';

// config.json is written by the deploy (user pool, API and WebSocket addresses), so it's read before start-up.
loadConfig()
  .then((cfg) => bootstrapApplication(App, { ...appConfig, providers: [{ provide: APP_CONFIG, useValue: cfg }, ...appConfig.providers] }))
  .catch((err) => console.error(err));
