# Tell Me

A vanilla JS slider-and-input challenge demo with server-issued tokens, form-unlock mode, and redirect mode.

## Run locally

```bash
npm install
npm start
```

Open:

```bash
http://localhost:3000
```

## What it does

- Shows a random slider target
- Lets the user drag the slider and type the same value
- Verifies the match on the server
- Either:
  - unlocks the form submit flow, or
  - redirects to a tokenized success page

## Settings

All settings live in `config.js` and can be overridden with environment variables.

### Challenge settings
- `CHALLENGE_MIN` — lowest slider value
- `CHALLENGE_MAX` — highest slider value
- `CHALLENGE_TTL_MS` — how long a challenge/token stays valid in milliseconds

### Redirect settings
- `REDIRECT_PATH` — the success page path, default: `/thanks`

### Contact settings
- `CONTACT_EMAIL` — shown on the success page, default: `hello@example.com`

### App/security settings
- `APP_NAME` — app name
- `PORT` — server port, default: `3000`
- `CHALLENGE_SECRET` — HMAC signing secret used for tokens

## Example

```bash
PORT=4000 \
CHALLENGE_MIN=1 \
CHALLENGE_MAX=40 \
REDIRECT_PATH=/thanks-for-contacting-us \
CONTACT_EMAIL=support@example.com \
npm start
```

## Where to edit behavior

- **Challenge values, TTL, redirect path, contact email**: `config.js`
- **Server verification and token logic**: `server.js`
- **UI labels and page text**: `public/index.html`
- **Client-side behavior**: `public/app.js`
- **Styling**: `public/styles.css`

## Notes

- The redirect page accepts the freshly issued token from the challenge flow.
- Visiting the redirect page directly without a token still shows a rejection message, which is expected.
- This is a modular starting point; it can later be adapted into:
  - plain HTML embeds
  - PHP integrations
  - WordPress blocks/plugins
