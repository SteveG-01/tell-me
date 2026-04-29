function createSliderChallenge(config) {
  const min = config.challenge.min;
  const max = config.challenge.max;
  const target = Math.floor(Math.random() * (max - min + 1)) + min;

  return {
    type: "slider",
    prompt: `Pick the number ${target}.`,
    answer: String(target),
    target,
    min,
    max,
  };
}

module.exports = createSliderChallenge;
