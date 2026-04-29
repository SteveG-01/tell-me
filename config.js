const path = require("path");

const config = {
  appName: process.env.APP_NAME || "Tell Me",
  port: Number(process.env.PORT || 3000),

  challenge: {
    min: Number(process.env.CHALLENGE_MIN || 1),
    max: Number(process.env.CHALLENGE_MAX || 20),
    ttlMs: Number(process.env.CHALLENGE_TTL_MS || 5 * 60 * 1000),
    defaultType: process.env.CHALLENGE_DEFAULT_TYPE || "slider",
    types: (process.env.CHALLENGE_TYPES || "slider,riddle")
      .split(",")
      .map((type) => type.trim())
      .filter(Boolean),
    riddles: [
      { question: "What has keys but can't open locks?", answer: "keyboard" },
      { question: "What gets wetter as it dries?", answer: "towel" },
      { question: "What has a ring but no finger?", answer: "phone" },
    ],
  },

  redirect: {
    path: process.env.REDIRECT_PATH || "/thanks",
  },

  contact: {
    email: process.env.CONTACT_EMAIL || "hello@example.com",
  },

  security: {
    secret: process.env.CHALLENGE_SECRET || "dev-secret-change-me",
  },

  publicDir: path.join(__dirname, "public"),
};

module.exports = config;
