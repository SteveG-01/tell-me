function createRiddleChallenge(config) {
  const riddle = config.challenge.riddles[Math.floor(Math.random() * config.challenge.riddles.length)];

  return {
    type: "riddle",
    prompt: riddle.question,
    answer: riddle.answer.toLowerCase(),
  };
}

module.exports = createRiddleChallenge;
