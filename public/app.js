const urlChallengeType = new URLSearchParams(window.location.search).get("type");
const persistedChallengeType = localStorage.getItem("tell-me.challengeType");
const state = {
  mode: "form",
  challengeType: urlChallengeType || persistedChallengeType || "slider",
  challenge: null,
  verifiedToken: null,
  solved: false,
  startedAt: Date.now(),
};

const elements = {
  form: document.getElementById("contactForm"),
  slider: document.getElementById("slider"),
  typedValue: document.getElementById("typedValue"),
  targetValue: document.getElementById("targetValue"),
  currentValue: document.getElementById("currentValue"),
  challengeTitle: document.getElementById("challengeTitle"),
  challengePrompt: document.getElementById("challengePrompt"),
  challengeBody: document.getElementById("challengeBody"),
  typedLabel: document.getElementById("typedLabel"),
  status: document.getElementById("status"),
  sendButton: document.getElementById("sendButton"),
  redirectLink: document.getElementById("redirectLink"),
  modeButtons: Array.from(document.querySelectorAll("[data-mode]")),
  typeButtons: Array.from(document.querySelectorAll("[data-challenge-type]")),
};

function setStatus(message, type = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
}

function setCurrentValue(value) {
  elements.currentValue.textContent = String(value);
}

function setChallengeBodyVisibility(type) {
  const isSlider = type === "slider";
  elements.challengeBody.classList.toggle("riddle-mode", !isSlider);
  elements.slider.closest(".slider-wrap").classList.toggle("hidden", !isSlider);
  elements.currentValue.closest(".current-pill").classList.toggle("hidden", !isSlider);
  if (elements.typedLabel?.firstChild) {
    elements.typedLabel.firstChild.textContent = isSlider ? "Type the same value" : "Answer the riddle";
  }
  elements.typedValue.placeholder = isSlider ? "Enter the slider value" : "Type the answer";
}

function updateModeUI() {
  elements.modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });

  elements.typeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.challengeType === state.challengeType);
  });

  elements.sendButton.classList.toggle("hidden", state.mode !== "form");
  elements.redirectLink.classList.toggle("hidden", state.mode !== "redirect");
  elements.redirectLink.setAttribute("aria-disabled", state.mode !== "redirect" ? "true" : "false");

  const params = new URLSearchParams(window.location.search);
  params.set("type", state.challengeType);
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
}

function setChallengeCopy() {
  if (!state.challenge) return;

  const isRiddle = state.challenge.type === "riddle";

  elements.challengeTitle.textContent = isRiddle ? "Answer the riddle" : "Follow the instructions";
  elements.challengePrompt.textContent = isRiddle
    ? `Riddle: ${state.challenge.prompt} Answer the question in the field below.`
    : `Pick the number shown and match it exactly.`;
  elements.targetValue.textContent = isRiddle
    ? "Riddle"
    : String(state.challenge.target ?? state.challenge.min ?? 1);
  elements.slider.min = String(state.challenge.min ?? 1);
  elements.slider.max = String(state.challenge.max ?? 20);
  elements.slider.value = String(state.challenge.min ?? 1);
  elements.typedValue.value = "";
  setCurrentValue(elements.slider.value);
  setChallengeBodyVisibility(state.challenge.type);
  elements.typedLabel.setAttribute("data-mode", state.challenge.type);
  elements.targetValue.closest(".target-pill").classList.toggle("hidden", isRiddle);
  elements.slider.title = isRiddle
    ? "Riddle mode does not use the slider"
    : `Move to ${String(state.challenge.target ?? "")}`;
  state.solved = false;
  state.verifiedToken = null;
  elements.sendButton.disabled = true;
  elements.redirectLink.href = "/thanks";
  setStatus("Solve the challenge to continue.");
}

async function loadChallenge(type) {
  const response = await fetch(`/api/challenge?type=${encodeURIComponent(type)}`);
  if (!response.ok) {
    throw new Error(`Challenge request failed with ${response.status}`);
  }

  const challenge = await response.json();
  if (!challenge || !challenge.challengeId || !challenge.type) {
    throw new Error("Challenge payload missing required fields");
  }

  state.challenge = challenge;
  state.challengeType = challenge.type;
  state.startedAt = Date.now();
  setChallengeCopy();
  updateModeUI();
}

async function verifyChallenge() {
  if (!state.challenge) return false;

  const payload = {
    challengeId: state.challenge.challengeId,
    sliderValue: elements.slider.value,
    typedValue: elements.typedValue.value,
    redirectMode: state.mode === "redirect",
    trapField: "",
    startedAt: state.startedAt,
  };

  const response = await fetch("/api/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok) {
    setStatus(result.error || "Verification failed.", "error");
    return false;
  }

  state.solved = true;
  state.verifiedToken = result.token;

  if (state.mode === "form") {
    elements.sendButton.disabled = false;
    setStatus("Verified. The send button is now enabled.", "success");
  } else {
    elements.redirectLink.href = result.redirectUrl;
    elements.redirectLink.classList.remove("hidden");
    elements.redirectLink.setAttribute("aria-disabled", "false");
    setStatus("Verified. Use the tokened redirect link.", "success");
  }

  return true;
}

elements.modeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.mode = button.dataset.mode;
    updateModeUI();
  });
});

elements.typeButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.challengeType = button.dataset.challengeType;
    localStorage.setItem("tell-me.challengeType", state.challengeType);
    updateModeUI();
    await loadChallenge(state.challengeType);
  });
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.solved) {
    const verified = await verifyChallenge();
    if (!verified) return;
    if (state.mode === "redirect") return;
  }

  if (state.mode === "form") {
    setStatus("Message sent. This is where your real form submit would happen.", "success");
  } else if (state.verifiedToken) {
    window.location.href = elements.redirectLink.href;
  }
});

elements.slider.min = String(1);
elements.slider.max = String(20);

elements.slider.addEventListener("input", () => {
  setCurrentValue(elements.slider.value);

  if (state.mode === "redirect") {
    setStatus("Match the slider value to continue.", "neutral");
  }
});

elements.typedValue.addEventListener("input", () => {
  if (state.mode === "redirect") {
    setStatus("Match the slider value to continue.", "neutral");
  }
});

loadChallenge(state.challengeType).catch((error) => {
  console.error(error);
  setStatus("Unable to load the challenge.", "error");
});
updateModeUI();
