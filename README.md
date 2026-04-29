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

- Shows a random slider or riddle challenge
- Lets the user solve the challenge in the browser
- Verifies the match on the server
- Either:
  - unlocks the form submit flow, or
  - redirects to a tokenized success page

## Security hardening

- Challenge requests and verification requests are rate-limited
- Repeated failed verification attempts trigger a temporary abuse throttle
- A hidden honeypot field and submission timing check add bot friction
- Challenges are bound to the issuing browser session cookie
- Success tokens are also bound to the issuing browser session
- `/api/stats` exposes aggregate counters and configured thresholds only

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

## Drop-in integration

If you want to drop Tell Me into a basic HTML site, the simplest pattern is:

1. Add a container for the challenge UI.
2. Request a challenge from `GET /api/challenge?type=slider` or `type=riddle`.
3. Render the prompt and collect the answer in your page.
4. Send the answer to `POST /api/verify`.
5. Only enable your real form submit after verification succeeds.

### What the user's site should look like

A basic integration usually has three pieces:

- **Your existing form** — for example, a contact form, signup form, or comment form.
- **A challenge area** — where Tell Me shows the prompt and answer field.
- **A verification state** — a button, message, or hidden flag that only becomes active after the challenge is solved.

The page does not need a framework. A plain HTML file plus a little vanilla JavaScript is enough.

### Full example

Save the following as something like `index.html` on the user's site:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My Site with Tell Me</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        line-height: 1.5;
        max-width: 720px;
        margin: 40px auto;
        padding: 0 16px;
      }

      form {
        display: grid;
        gap: 16px;
      }

      label {
        display: grid;
        gap: 6px;
      }

      input, button {
        font: inherit;
        padding: 10px 12px;
      }

      .challenge-box {
        border: 1px solid #ccc;
        border-radius: 8px;
        padding: 16px;
        background: #fafafa;
      }

      .challenge-status {
        margin-top: 12px;
        font-weight: bold;
      }

      .challenge-status.error {
        color: #b00020;
      }

      .challenge-status.success {
        color: #0a7a2f;
      }
    </style>
  </head>
  <body>
    <h1>Contact us</h1>

    <form id="contactForm">
      <label>
        Name
        <input id="name" name="name" type="text" required />
      </label>

      <label>
        Email
        <input id="email" name="email" type="email" required />
      </label>

      <label>
        Message
        <textarea id="message" name="message" rows="5" required></textarea>
      </label>

      <div class="challenge-box">
        <h2>Human verification</h2>
        <p>Complete the challenge before sending the form.</p>

        <div id="challengeMount">Loading challenge…</div>

        <div id="challengeStatus" class="challenge-status" aria-live="polite"></div>

        <button type="button" id="loadChallengeButton">Load challenge</button>
        <button type="button" id="verifyChallengeButton">Verify answer</button>
      </div>

      <button type="submit" id="submitButton" disabled>Send message</button>
    </form>

    <script>
      const API_BASE = "http://localhost:3000";
      const CHALLENGE_TYPE = "slider";

      const form = document.getElementById("contactForm");
      const nameInput = document.getElementById("name");
      const emailInput = document.getElementById("email");
      const messageInput = document.getElementById("message");
      const challengeMount = document.getElementById("challengeMount");
      const challengeStatus = document.getElementById("challengeStatus");
      const loadChallengeButton = document.getElementById("loadChallengeButton");
      const verifyChallengeButton = document.getElementById("verifyChallengeButton");
      const submitButton = document.getElementById("submitButton");

      let currentChallengeId = "";
      let startedAt = 0;

      function setStatus(message, type = "") {
        challengeStatus.textContent = message;
        challengeStatus.className = type ? `challenge-status ${type}` : "challenge-status";
      }

      function setVerified(isVerified) {
        submitButton.disabled = !isVerified;
        verifyChallengeButton.disabled = isVerified;
        loadChallengeButton.disabled = false;
      }

      async function loadChallenge() {
        setStatus("Loading a new challenge…");
        submitButton.disabled = true;
        verifyChallengeButton.disabled = false;

        try {
          const response = await fetch(`${API_BASE}/api/challenge?type=${CHALLENGE_TYPE}`, {
            credentials: "include",
          });

          const challenge = await response.json();

          if (!response.ok) {
            throw new Error(challenge.error || "Unable to load challenge");
          }

          currentChallengeId = challenge.challengeId;
          startedAt = Date.now();

          if (challenge.type === "slider") {
            challengeMount.innerHTML = `
              <p><strong>${challenge.prompt}</strong></p>
              <label>
                Your answer
                <input id="sliderValue" type="number" inputmode="numeric" autocomplete="off" />
              </label>
            `;
          } else {
            challengeMount.innerHTML = `
              <p><strong>${challenge.prompt}</strong></p>
              <label>
                Your answer
                <input id="typedValue" type="text" autocomplete="off" />
              </label>
            `;
          }

          setStatus("Challenge loaded. Enter your answer and click Verify.", "");
          setVerified(false);
        } catch (error) {
          challengeMount.innerHTML = "";
          setStatus(`Could not load challenge: ${error.message}`, "error");
        }
      }

      async function verifyChallenge() {
        if (!currentChallengeId) {
          setStatus("Load a challenge first.", "error");
          return;
        }

        const sliderValueEl = document.getElementById("sliderValue");
        const typedValueEl = document.getElementById("typedValue");

        const payload = {
          challengeId: currentChallengeId,
          sliderValue: sliderValueEl ? sliderValueEl.value : "",
          typedValue: typedValueEl ? typedValueEl.value : "",
          redirectMode: false,
          trapField: "",
          startedAt,
        };

        setStatus("Verifying…");

        try {
          const response = await fetch(`${API_BASE}/api/verify`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          const result = await response.json();

          if (!response.ok || !result.ok) {
            throw new Error(result.error || "Verification failed");
          }

          setStatus("Verified. You may now submit the form.", "success");
          setVerified(true);
        } catch (error) {
          setStatus(`Verification failed: ${error.message}`, "error");
          setVerified(false);
        }
      }

      loadChallengeButton.addEventListener("click", loadChallenge);
      verifyChallengeButton.addEventListener("click", verifyChallenge);

      form.addEventListener("submit", (event) => {
        if (submitButton.disabled) {
          event.preventDefault();
          setStatus("Please complete verification before sending.", "error");
          return;
        }

        event.preventDefault();

        alert(
          `Form submitted!\n\nName: ${nameInput.value}\nEmail: ${emailInput.value}\nMessage: ${messageInput.value}`
        );
      });

      loadChallenge();
    </script>
  </body>
</html>
```

### What this example does

- loads a challenge automatically when the page opens
- lets the user click **Verify answer**
- sends the challenge response to Tell Me
- enables the real form submit button only after verification succeeds
- keeps the user on the same page, which is ideal for a basic HTML site

### How to test it locally

1. Start Tell Me:
   ```bash
   npm start
   ```

2. Save the HTML file above and open it in a browser.

3. Confirm you see:
   - the form
   - the challenge box
   - a prompt from Tell Me

4. Enter the correct answer:
   - for slider mode, type the number shown by the challenge
   - for riddle mode, type the answer to the riddle

5. Click **Verify answer**.

6. Confirm:
   - the status changes to “Verified”
   - the **Send message** button becomes enabled

7. Click **Send message** and confirm the form submission is now allowed.

### Important notes for beginners

- If the challenge never loads, make sure Tell Me is running on `http://localhost:3000`.
- If verification fails unexpectedly, check that your browser is keeping cookies enabled.
- If your page is on a different domain than Tell Me, you will need CORS support and `credentials: "include"` on the requests.
- In production, use HTTPS so the cookie can be marked `Secure`.

### If you want redirect mode instead of submit-unlock mode

You can swap the verification success behavior to redirect the browser using the `redirectUrl` returned by `/api/verify`. That is useful if you want the user to land on a confirmation page rather than enabling the form in place.

### Minimal local test flow
- Run Tell Me with `npm start`.
- Open your HTML page in a browser.
- Trigger a challenge request from your page.
- Solve the challenge.
- Confirm the verification succeeds.
- Confirm your submit button or redirect behavior only unlocks after success.

## Notes

- The redirect page accepts the freshly issued token from the challenge flow.
- Visiting the redirect page directly without a token still shows a rejection message, which is expected.
- This is a modular starting point; it can later be adapted into:
  - plain HTML embeds
  - PHP integrations
  - WordPress blocks/plugins
