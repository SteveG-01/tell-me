const createSliderChallenge = require("./slider");
const createRiddleChallenge = require("./riddle");

const challengeFactories = {
  slider: createSliderChallenge,
  riddle: createRiddleChallenge,
};

function getChallengeFactory(type) {
  return challengeFactories[type] || challengeFactories.slider;
}

module.exports = {
  challengeFactories,
  getChallengeFactory,
};
